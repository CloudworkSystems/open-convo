# Email actions preview

This standalone library turns invented or connector-supplied messages and action requests into a deterministic, sealed preview. It does not connect to a mailbox, fetch or open a URL, send mail, delete anything, report anything, use AI, or write files.

```sh
node src/preview.mjs --messages fixtures/mailbox.json --requests fixtures/requests.json
node src/preview.mjs --messages fixtures/mailbox.json --requests fixtures/requests.json --json
```

Code can call the synchronous `previewActions(messages, requests)` export from `src/index.mjs`. A refusal throws `EmailActionsError`; the function prints nothing and does not read the clock.

## Inputs

The messages file has `schemaVersion: 1` and up to 10,000 messages in `messages`. It is limited to 5 MB. Each message has the sorting-engine fields `id`, `inbox`, `from`, `to`, `subject`, `date`, `snippet`, and `headers`, plus an optional `pile`: `people`, `work`, `alerts`, `receipts`, `newsletters`, or `other`. A missing `pile` counts as unsorted and is reported as `unsorted` when directly selected. Only `Message-ID`, `List-Id`, `List-Unsubscribe`, and `List-Unsubscribe-Post` affect a preview.

The requests file has `schemaVersion: 1` and 1 to 200 entries in `requests`. An entry has an `action` (`unsubscribe`, `spam`, or `delete`) and exactly one target:

- `sender`: one exact address;
- `domain`: a domain beginning with `@`;
- `listId`: the identifier inside a `List-Id` header;
- `messages`: 1 to 1,000 `{ inbox, id }` references.

An optional `pile` narrows sender, domain, and list targets. Unknown or missing fields and references to absent messages are refused.

## Guards

Sender, domain, and list sweeps leave out People and Work messages and tell the owner to pick those messages one by one. They also leave out messages with no `pile` as not sorted yet, including when a request has a `pile` filter. Each is counted in that request's `leftOut`; if every match is left out, the request is blocked as matching nothing. Only a direct `messages` target may include these messages.

The preview also blocks sender and domain sweeps for addresses that receive mail in the input, blocks an empty match, and blocks these large consumer mail domains because a sweep could catch unrelated people:

`aol.com`, `gmail.com`, `googlemail.com`, `hotmail.com`, `icloud.com`, `live.com`, `mac.com`, `me.com`, `msn.com`, `outlook.com`, `proton.me`, `protonmail.com`, `yahoo.com`, `ymail.com`.

Spam wins when both spam and delete match one message, but the kept message names every matching request. Unsubscribe remains independent of either message action.

## Unsubscribe methods

The newest selected message in each List-Id or sender group decides the method:

- `oneClick`: an HTTPS URI plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`;
- `mailto`: the exact recipients, subject, and body in a `mailto:` URI;
- `webPage`: an HTTPS URI the Desk may show for the owner to open;
- `none`: no usable method, with a plain reason.

An HTTP-only link is insecure. URLs longer than 2,000 characters or containing credentials are unusable. A mail URI containing any field other than `subject` and `body`, including `cc`, `bcc`, or `from`, is unusable. URLs are parsed as text with Node's WHATWG `URL`; none is opened, resolved, or fetched.

## Output and seal

The result is `{ schemaVersion, seal, actions, unsubscribe, blocked, requests, summary }`. Actions are always ordered spam, delete, unsubscribe. Their groups follow the fixed pile order, then newest sender group, and messages are newest first. A logical message lists every inbox and every id in that inbox; duplicate `Message-ID` copies are shown once but all copies are counted and sealed.

The canonical form is UTF-8 `JSON.stringify` of this object, with properties in the shown order:

```json
{
  "actions": [
    { "action": "spam", "messages": [{ "inbox": "home", "id": "m-1" }] },
    { "action": "delete", "messages": [] },
    { "action": "unsubscribe", "messages": [] }
  ],
  "unsubscribe": [
    { "key": "address:news@paper.example", "method": "mailto", "to": ["leave@paper.example"], "subject": "remove", "body": "" }
  ]
}
```

Every action's copies are sorted by inbox then id. Unsubscribe entries are sorted by key. A one-click or web-page entry has `key`, `method`, `url`; a mail entry has `key`, `method`, `to`, `subject`, `body`; `none` has only `key`, `method` because it executes nothing. `seal` is the lowercase hex SHA-256 of that exact JSON text. `canonicalActionForm(actions, unsubscribe)` is exported so a later executor can rebuild the form. The seal is neither a secret nor a signature.

## Edge cases

- RFC 5322 field names compare case-insensitively without trimming. If differently cased copies of a field occur, their values are read in character-code order; the first non-empty field value is used.
- `Message-ID` and `List-Id` use the first angle-bracketed token when present, otherwise the trimmed field body. Comparison is lower case. An identifier over 200 characters is replaced with a deterministic SHA-256 marker, matching the sorting engine.
- RFC 2369 unsubscribe URIs must be inside angle brackets. Preference is usable one-click HTTPS, then usable mail, then HTTPS web page, regardless of header order.
- An RFC 6068 mail URI must name exactly one valid ASCII dot-atom `local@domain` recipient. The local part cannot be quoted and the domain must have at least two labels, with letters, digits, and interior hyphens only; IDN domains are not accepted. Empty recipients, recipient lists, display names, angle brackets, whitespace, a `to` query field, and the decoded address characters `?`, `&`, `;`, `:`, `/`, and `,` make it unusable. Percent encoding is decoded, while a literal `+` remains `+` rather than becoming a space. Repeated `subject` or `body` fields use the first value, and empty query parameters (including a trailing `&`) are ignored. Decoded field names, subjects, and bodies refuse C0 controls other than tab, DEL, C1 controls, U+2028, and U+2029; this includes the existing CR/LF refusal. A fragment or malformed percent encoding also makes the mail URI unusable. An absent subject or body becomes empty text.
- Address and domain comparisons trim surrounding whitespace and use locale-independent lower case. Display text is returned unchanged.
- Dates must be RFC 3339 date-times with an explicit offset. Equal instants are ordered by inbox and id, never by locale or file order.

Run all tests with:

```sh
npm test
```

The included invented fixture is a small, realistic multi-inbox mailbox. It covers People and Work protection, unsorted mail, duplicate `Message-ID` copies, and a blocked sweep without using real people, companies, or routable domains.
