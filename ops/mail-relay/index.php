<?php
/**
 * VFW mail relay — hand a message to a mail server that is allowed to send.
 *
 * WHY THIS EXISTS
 * ---------------
 * Railway silently drops every outbound SMTP port. Measured from inside the
 * running container:
 *
 *     mail.veeb.co.ke:465  -> TIMEOUT (silently dropped)
 *     mail.veeb.co.ke:587  -> TIMEOUT (silently dropped)
 *     smtp.gmail.com:465   -> ETIMEDOUT
 *     api.github.com:443   -> CONNECTED in 73ms
 *
 * So the app cannot dial a mailbox, however correct the credentials — the same
 * ones authenticate in 1.7s from a normal machine. But it CAN make an HTTPS
 * request. This box already sends mail perfectly well. So the app POSTs the
 * message here over 443, and this hands it to the local mail server.
 *
 * No third party, no monthly cap, no expiring free tier, and mail keeps coming
 * from veeb.co.ke with the domain's own SPF/DKIM.
 *
 * INSTALL
 * -------
 *   1. Put this file at:  /home3/veebcoke/public_html/vfw-relay/index.php
 *   2. Set RELAY_TOKEN below to a long random string (see README.md).
 *   3. chmod 600 is NOT wanted — the web server must read it. 644 is right.
 *   4. Confirm https://veeb.co.ke/vfw-relay/ returns {"ok":false,...} and NOT a
 *      404 or a directory listing.
 *
 * SECURITY
 * --------
 * This endpoint can send email to anyone, so it is guarded:
 *   - a shared token, compared in constant time (hash_equals);
 *   - the From address must be on an allowed domain, so a leaked token cannot
 *     be used to spoof someone else's brand;
 *   - a rolling hourly cap, so a leaked token cannot empty the server's
 *     reputation overnight before anyone notices;
 *   - POST + JSON only, with a body size limit.
 * It is not an open relay: without the token it does nothing at all.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The shared secret. MUST match RELAY token stored in the app's mail account.
 * Replace this before going live — a relay with the placeholder token is an
 * open relay for anyone who reads this file in a git repo.
 */
const RELAY_TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

/** Only these domains may appear in the From address. */
const ALLOWED_FROM_DOMAINS = ['veeb.co.ke'];

/** Most messages this relay will send in any rolling hour. */
const HOURLY_LIMIT = 200;

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 512 * 1024;

/** Where the rolling counter lives. Outside the web root on purpose. */
const COUNTER_FILE = __DIR__ . '/../../vfw-relay-counter.json';

// ---------------------------------------------------------------------------

header('Content-Type: application/json');
// This is a machine endpoint; nothing should index, cache, or embed it.
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: no-store');

function fail(int $status, string $message): void {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST a JSON message here.');
}

// Read the token from a header, falling back to Authorization: Bearer. Some
// shared hosts strip unknown X- headers from the CGI environment, and finding
// that out via silent 401s is a bad afternoon.
$provided = $_SERVER['HTTP_X_RELAY_TOKEN'] ?? '';
if ($provided === '') {
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (stripos($auth, 'Bearer ') === 0) {
        $provided = substr($auth, 7);
    }
}

// Refuse to run with the shipped placeholder — an unconfigured relay must fail
// closed, not become an open one.
//
// This deliberately does NOT compare against the placeholder literal. Installing
// means find-and-replacing that string, and a replace-ALL would rewrite the
// comparison too, leaving `if (RELAY_TOKEN === '<your real token>')` — always
// true, so a correctly configured relay would insist it was unconfigured
// forever. Both tests below survive replacing the full placeholder: 'CHANGE_ME'
// is a shorter, distinct literal, and a real token clears the length bar.
if (str_contains(RELAY_TOKEN, 'CHANGE_ME') || strlen(RELAY_TOKEN) < 24) {
    fail(500, 'Relay is not configured: set RELAY_TOKEN to a long random string.');
}

// Constant-time: a plain === leaks the token one character at a time to anyone
// patient enough to measure the difference.
if ($provided === '' || !hash_equals(RELAY_TOKEN, $provided)) {
    fail(401, 'Bad or missing relay token.');
}

$raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($raw === false || $raw === '') {
    fail(400, 'Empty body.');
}
if (strlen($raw) > MAX_BODY_BYTES) {
    fail(413, 'Message too large.');
}

$msg = json_decode($raw, true);
if (!is_array($msg)) {
    fail(400, 'Body must be JSON.');
}

$to          = trim((string)($msg['to'] ?? ''));
$subject     = trim((string)($msg['subject'] ?? ''));
$html        = (string)($msg['html'] ?? '');
$text        = (string)($msg['text'] ?? '');
$fromAddress = trim((string)($msg['fromAddress'] ?? ''));
$fromName    = trim((string)($msg['fromName'] ?? ''));

if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
    fail(400, 'A valid "to" address is required.');
}
if ($subject === '') {
    fail(400, '"subject" is required.');
}
if ($html === '' && $text === '') {
    fail(400, 'One of "html" or "text" is required.');
}
if ($fromAddress === '' || !filter_var($fromAddress, FILTER_VALIDATE_EMAIL)) {
    fail(400, 'A valid "fromAddress" is required.');
}

// A leaked token must not become a way to send as anyone at all.
$fromDomain = strtolower(substr(strrchr($fromAddress, '@') ?: '', 1));
if (!in_array($fromDomain, ALLOWED_FROM_DOMAINS, true)) {
    fail(403, 'That From domain is not allowed by this relay.');
}

// Header injection: a newline in any of these would let the caller append
// arbitrary headers (Bcc: everyone). Reject rather than strip — a subject that
// contains a newline is not a subject we were meant to send.
foreach (['to' => $to, 'subject' => $subject, 'fromAddress' => $fromAddress, 'fromName' => $fromName] as $field => $value) {
    if (preg_match('/[\r\n]/', $value)) {
        fail(400, "Illegal newline in \"$field\".");
    }
}

// --- rolling hourly cap ----------------------------------------------------
// Best-effort, and deliberately fails OPEN: if the counter file cannot be read
// or written, mail still goes. A relay that stops sending because of a
// bookkeeping problem is worse than one that briefly overshoots a soft limit.
$now = time();
$fh = @fopen(COUNTER_FILE, 'c+');
if ($fh !== false) {
    if (@flock($fh, LOCK_EX)) {
        $body = stream_get_contents($fh) ?: '';
        $state = json_decode($body, true);
        $stamps = is_array($state['sent'] ?? null) ? $state['sent'] : [];
        // Keep only the last hour.
        $stamps = array_values(array_filter($stamps, static fn($t) => is_int($t) && $t > $now - 3600));
        if (count($stamps) >= HOURLY_LIMIT) {
            @flock($fh, LOCK_UN);
            @fclose($fh);
            fail(429, 'Relay hourly limit reached (' . HOURLY_LIMIT . '). Try later.');
        }
        $stamps[] = $now;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode(['sent' => $stamps]));
        fflush($fh);
        @flock($fh, LOCK_UN);
    }
    @fclose($fh);
}

// --- compose ---------------------------------------------------------------
// multipart/alternative so clients that refuse HTML still show something, which
// is the same contract the app's own templates assume.
$boundary = '=_vfw_' . bin2hex(random_bytes(16));

$fromHeader = $fromName !== ''
    // Encode the display name: it may carry non-ASCII, and a raw 8-bit byte in a
    // header is what turns "VFW Console" into mojibake in half of all clients.
    ? sprintf('=?UTF-8?B?%s?= <%s>', base64_encode($fromName), $fromAddress)
    : $fromAddress;

$headers = [
    'MIME-Version: 1.0',
    'From: ' . $fromHeader,
    'Reply-To: ' . $fromAddress,
    'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    'X-Mailer: vfw-relay',
];

$parts = [];
if ($text !== '') {
    $parts[] = "--$boundary\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($text));
}
if ($html !== '') {
    $parts[] = "--$boundary\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($html));
}
$body = implode('', $parts) . "--$boundary--";

// Subject may be non-ASCII too.
$encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';

// -f sets the envelope sender, which is what SPF is checked against. Without it
// the envelope is the cPanel user and SPF alignment suffers.
$ok = mail($to, $encodedSubject, $body, implode("\r\n", $headers), '-f' . $fromAddress);

if (!$ok) {
    fail(502, 'The local mail server refused the message.');
}

echo json_encode(['ok' => true]);
