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

/**
 * How this box hands the message to the mail server.
 *
 * PHP's mail() is disabled on this host (confirmed live: the relay answered
 * "PHP mail() is disabled" on 2026-07-15), which many cPanel providers do to
 * force authenticated SMTP. So the relay speaks SMTP itself.
 *
 * This connection is LOCAL to this box — the same handshake that authenticates
 * in ~1.7s from any normal machine. It has nothing to do with the Railway block
 * that started all this: Railway cannot reach an SMTP port, but this server can,
 * which is the entire point of the relay sitting here.
 *
 * Leave SMTP_HOST empty to use mail() instead, on a host where it works.
 */
const SMTP_HOST = 'mail.veeb.co.ke';
const SMTP_PORT = 465;          // 465 = implicit TLS. 587 = STARTTLS (not implemented here).
const SMTP_USER = 'patriotic@veeb.co.ke';
/**
 * The mailbox password. Set it on the SERVER copy of this file only.
 *
 * It stays a placeholder in the repository because that repository is PUBLIC —
 * a real password committed here is world-readable forever, in history, even
 * after a later commit removes it. This file lives on your own box and is not in
 * git, so it is the right place for the value and the wrong place to template it
 * from. Leave an empty SMTP_USER to send without authentication.
 */
const SMTP_PASS = 'CHANGE_ME_SMTP_PASSWORD';
/** Seconds to wait on the mail server before giving up. */
const SMTP_TIMEOUT = 20;

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

/**
 * Whether the caller has proved they hold the token. Gates how much detail the
 * crash handler below is willing to say out loud.
 */
$authed = false;

/**
 * Never answer with an opaque 500.
 *
 * A PHP fatal (a disabled function, a missing extension) otherwise produces an
 * empty body with `display_errors` off, and the caller is left guessing — which
 * is exactly how the first live send failed: HTTP 500, zero bytes, no way to
 * tell mail() being disabled from a typo. The app already reports whatever this
 * returns, so turning a fatal into JSON turns a guessing game into a sentence.
 *
 * The message is only included for a caller who passed the token check. An
 * unauthenticated stranger gets nothing but "crashed": PHP fatals name file
 * paths and function names, and that is free reconnaissance.
 */
register_shutdown_function(static function () use (&$authed): void {
    $e = error_get_last();
    if (!$e || !in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        return;
    }
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode([
        'ok' => false,
        'error' => $authed
            ? 'Relay crashed: ' . $e['message'] . ' (' . basename($e['file']) . ':' . $e['line'] . ')'
            : 'Relay crashed.',
    ]);
});

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
// From here on the caller is trusted enough to be told why something broke.
$authed = true;

// One of the two paths must exist, or nothing can be sent. Say which, in a
// sentence: "Call to undefined function mail()" tells an operator nothing about
// what to do next, and this host disables mail() precisely to push callers to
// SMTP — so if neither is available, that is the message worth returning.
if (SMTP_HOST === '' && !function_exists('mail')) {
    fail(501, 'PHP mail() is disabled on this host and no SMTP_HOST is set in the relay, so there is no way to send.');
}
// Same fail-closed rule as the token: a placeholder password would otherwise
// reach the mail server as a login attempt and come back "535 Incorrect
// authentication data", which reads like a wrong password rather than an
// unfinished install. Substring test, so a replace-all of the placeholder cannot
// disable the check (see the RELAY_TOKEN note above).
if (SMTP_HOST !== '' && SMTP_USER !== '' && str_contains(SMTP_PASS, 'CHANGE_ME')) {
    fail(500, 'Relay is not configured: set SMTP_PASS to the mailbox password.');
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

if (SMTP_HOST !== '') {
    // The SMTP path needs the full RFC 5322 message, so Subject and To become
    // headers rather than separate arguments the way mail() takes them.
    $smtpHeaders = array_merge([
        'Date: ' . date('r'),
        'To: ' . $to,
        'Subject: ' . $encodedSubject,
        // A Message-ID from our own domain. Without one, some receivers dock
        // reputation and duplicate-detection gets unpredictable.
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . ($fromDomain ?: 'localhost') . '>',
    ], $headers);

    $error = null;
    $ok = smtp_send($fromAddress, $to, implode("\r\n", $smtpHeaders) . "\r\n\r\n" . $body, $error);
    if (!$ok) {
        fail(502, 'The mail server refused the message: ' . $error);
    }
} else {
    // -f sets the envelope sender, which is what SPF is checked against. Without
    // it the envelope is the cPanel user and SPF alignment suffers.
    $ok = mail($to, $encodedSubject, $body, implode("\r\n", $headers), '-f' . $fromAddress);
    if (!$ok) {
        fail(502, 'The local mail server refused the message.');
    }
}

echo json_encode(['ok' => true]);

// ---------------------------------------------------------------------------
// A minimal SMTP client.
//
// Deliberately not a library: this speaks exactly the eight verbs needed to hand
// one message to one server, and every step checks the reply code rather than
// assuming. SMTP fails in ways that look like success if you do not read the
// replies — a 550 on RCPT with the socket still open is the classic.
// ---------------------------------------------------------------------------

/** Read one complete reply, following multi-line continuations ("250-..."). */
function smtp_read($fp, ?string &$error): ?string {
    $out = '';
    while (($line = fgets($fp, 1024)) !== false) {
        $out .= $line;
        // A space in the 4th column marks the final line; a hyphen means more.
        if (strlen($line) >= 4 && $line[3] === ' ') {
            return $out;
        }
    }
    $error = 'the mail server closed the connection';
    return null;
}

/** Send one command and require an expected reply code. */
function smtp_cmd($fp, ?string $cmd, string $expect, ?string &$error): bool {
    if ($cmd !== null) {
        fwrite($fp, $cmd . "\r\n");
    }
    $reply = smtp_read($fp, $error);
    if ($reply === null) {
        return false;
    }
    if (strncmp($reply, $expect, strlen($expect)) !== 0) {
        // Trim: replies are multi-line and end in CRLF, and the whole thing ends
        // up in an admin-facing error string.
        $error = trim(preg_replace('/\s+/', ' ', $reply));
        return false;
    }
    return true;
}

function smtp_send(string $from, string $to, string $data, ?string &$error): bool {
    $transport = SMTP_PORT === 465 ? 'ssl://' : '';
    $fp = @stream_socket_client(
        $transport . SMTP_HOST . ':' . SMTP_PORT,
        $errno,
        $errstr,
        SMTP_TIMEOUT,
        STREAM_CLIENT_CONNECT
    );
    if (!$fp) {
        $error = 'cannot reach ' . SMTP_HOST . ':' . SMTP_PORT . ' — ' . ($errstr ?: "error $errno");
        return false;
    }
    stream_set_timeout($fp, SMTP_TIMEOUT);

    $helo = ALLOWED_FROM_DOMAINS[0] ?? 'localhost';
    $ok = smtp_cmd($fp, null, '220', $error)                       // greeting
        && smtp_cmd($fp, 'EHLO ' . $helo, '250', $error);

    if ($ok && SMTP_USER !== '') {
        $ok = smtp_cmd($fp, 'AUTH LOGIN', '334', $error)
            && smtp_cmd($fp, base64_encode(SMTP_USER), '334', $error)
            && smtp_cmd($fp, base64_encode(SMTP_PASS), '235', $error);
        if (!$ok && $error !== null) {
            // The password must never surface in an error the app will display.
            $error = 'login rejected (' . $error . ')';
        }
    }

    if ($ok) {
        $ok = smtp_cmd($fp, 'MAIL FROM:<' . $from . '>', '250', $error)
            && smtp_cmd($fp, 'RCPT TO:<' . $to . '>', '250', $error)
            && smtp_cmd($fp, 'DATA', '354', $error);
    }

    if ($ok) {
        // Dot-stuffing: a line that is exactly "." ends the message, so any line
        // starting with one must be doubled or the mail truncates silently. Our
        // bodies are base64 today, but a future plain-text part would hit this.
        $safe = preg_replace('/^\./m', '..', $data);
        fwrite($fp, $safe . "\r\n.\r\n");
        $ok = smtp_cmd($fp, null, '250', $error);
    }

    // Politeness, and it flushes the server's queue decision before we hang up.
    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);
    return $ok;
}
