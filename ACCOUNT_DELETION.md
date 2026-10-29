# Member account deletion

## Server contract

`POST /api/auth/delete-account` uses the existing authenticated `club_session`
cookie. Send `Content-Type: application/json` and:

```json
{"confirm":true}
```

- Success: `200 {"ok":true}`; the session cookie is expired.
- Missing/invalid session: `401`.
- Missing explicit JSON confirmation: `400`.
- Enabled administrator account: `403`.

The server derives the target account from the session. An email, account ID or
other target supplied by the client is not used.

## Boundaries

The transaction marks the account `deleted`, records the deletion time, clears
its name, login alias, password hash/tag and recoverable credentials, and revokes
all its sessions. Pending access mail is blocked and stored credential ciphertext
is cleared. Already dispatched external mail cannot be recalled, but its old
credentials no longer authenticate.

The historical account key and financial evidence remain. Orders, payments,
consents, webhook evidence and support history are not erased. Confirmed payment
does not become a failed payment merely because account access was deleted.
Late provider notifications must not reactivate the same account.

This is self-service account closure, not a promise to erase every personal
detail from retained financial records or a guarantee of app-store approval.

## Web and native callers

The web profile has a separate **Удалить аккаунт** button below logout and an
explicit confirmation dialog. After success it returns to the sign-in screen.
Cancellation does not change the account.

Native clients use the same session contract. After a successful response they
must clear local account state and return to authentication. Native-client
changes are maintained separately.

## Verification

Run `bash test-passwords.sh` with PostgreSQL tools, Chromium and Playwright
available. It tests the real closed-sales guard first, then creates a disposable
source fixture with checkout open only for synthetic payment tests. Production
source and production databases are not modified by this harness.

Covered scenarios include missing authentication/confirmation, account deletion,
old-password and old-session rejection, admin protection, retained payment
evidence, blocked credential mail, late Prodamus notifications and late
CloudPayments fulfillment against a stale pending order projection.
