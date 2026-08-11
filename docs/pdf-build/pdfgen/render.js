const puppeteer = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const CHROME = 'E:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const COVER_SRC = path.join(ROOT, 'cover-toc.html');
const CONTENT_SRC = path.join(ROOT, 'content.html');
const COVER_PDF = path.join(ROOT, 'cover-toc.pdf');
const CONTENT_PDF = path.join(ROOT, 'content.pdf');
const OUT = path.join(ROOT, 'user-manual.pdf');

const headerTemplate = `
<div style="width:100%;font-family:'Work Sans',Arial,sans-serif;font-size:7.5px;
  color:#8a8a8a;padding:6px 22mm 0;display:flex;justify-content:space-between;
  border-bottom:0.5px solid #ddd;">
  <span style="letter-spacing:0.08em;text-transform:uppercase;">VFW Console — User Manual</span>
  <span style="color:#4fb8ce;font-weight:600;">Internal document</span>
</div>`;

const footerTemplate = `
<div style="width:100%;font-family:'Work Sans',Arial,sans-serif;font-size:7.5px;
  color:#8a8a8a;padding:0 22mm 6px;display:flex;justify-content:space-between;">
  <span>Vancouver Fashion Week</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox'],
  });

  // Cover + TOC: full bleed, no header/footer chrome.
  const coverPage = await browser.newPage();
  await coverPage.goto('file:///' + COVER_SRC.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await coverPage.evaluateHandle('document.fonts.ready');
  await coverPage.pdf({
    path: COVER_PDF,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: false,
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  await coverPage.close();

  // Body content: normal margins, branded running header/footer.
  const contentPage = await browser.newPage();
  await contentPage.goto('file:///' + CONTENT_SRC.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await contentPage.evaluateHandle('document.fonts.ready');
  await contentPage.pdf({
    path: CONTENT_PDF,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    // left/right match the 22mm inset the header/footer templates use, so
    // body text lines up under the running header instead of running edge-to-edge.
    margin: { top: '20mm', bottom: '16mm', left: '22mm', right: '22mm' },
  });
  await contentPage.close();
  await browser.close();

  // Merge: cover/TOC pages first, then content pages.
  const merged = await PDFDocument.create();
  const coverBytes = fs.readFileSync(COVER_PDF);
  const contentBytes = fs.readFileSync(CONTENT_PDF);
  const coverDoc = await PDFDocument.load(coverBytes);
  const contentDoc = await PDFDocument.load(contentBytes);

  const coverPages = await merged.copyPages(coverDoc, coverDoc.getPageIndices());
  coverPages.forEach((p) => merged.addPage(p));
  const contentPages = await merged.copyPages(contentDoc, contentDoc.getPageIndices());
  contentPages.forEach((p) => merged.addPage(p));

  const mergedBytes = await merged.save();
  fs.writeFileSync(OUT, mergedBytes);

  console.log('Cover/TOC pages:', coverDoc.getPageCount());
  console.log('Content pages:', contentDoc.getPageCount());
  console.log('Merged PDF written to', OUT);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
