# Private PDF delivery

The club checks its existing active-premium session before issuing a PDF URL.
Selectel serves all PDF bytes directly; the club server does not proxy files.
Payments, account credentials, legal documents, and text articles are unchanged.

## Runtime credentials

Configure `SELECTEL_PDF_ACCESS_KEY_ID` and `SELECTEL_PDF_SECRET_ACCESS_KEY`
as secret variables in ONREZA for the club only. Use a separate service user
with `s3:GetObject` on `club-fabrika-pdf/*`. Do not use the uploader's key.
Do not commit keys or presigned links, or log redirect locations.

## Behavior

`GET /api/pdfs/:id` opens the original PDF inline.
`GET /api/pdfs/:id?download=1` downloads the original with its UTF-8 filename.
Both URLs check the existing database-backed session, tariff, status, and expiry.
The catalog is an allowlist; clients cannot supply arbitrary object names.
Presigned links expire after one hour, are bearer links until expiry, and are
not cached by the club. Large files support S3 byte ranges.

The four starter articles keep their text and also offer their original PDFs.
Public legal documents are not part of this migration.

## Verification and publication

Run `node --test *.test.mjs`.
Verify the read-only key can get PDF objects and cannot put or delete objects.
Set runtime secrets before publishing or promoting the changes.
After publication, check anonymous access, active-member opening and download,
original filenames, mobile layout, and range requests for the largest PDF.
Never upload PDFs themselves or source credentials to GitHub.
