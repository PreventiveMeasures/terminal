# Base64 vectors

Source: [ExodusOSS/bytes tests/base64.test.js](https://github.com/ExodusOSS/bytes/blob/c33d586715d461d0c6171e4cf7c71a06eda447ec/tests/base64.test.js), version 1.15.1, commit `c33d586715d461d0c6171e4cf7c71a06eda447ec`. The original ExodusMovement/bytes URL redirects to this repository. See LICENSE for its MIT notice.

`exodus.json` retains all four deterministic byte vectors and all 58 string entries from `INVALID_FROM_LAX`, `INVALID_FROM_SPACES`, `INVALID_FROM_PADDED`, and `INVALID_FROM_CONTENT`. The string entries contain 57 unique values; the repeated `aa===` entry is retained. Hexadecimal outputs and validity are GNU command expectations, independently derived from quartet decoding and GNU's partial-output rules.

The library rejects every string in those four rejection arrays. GNU base64 instead accepts the six LF-only or LF-separated entries, preserves recoverable bytes before an invalid quartet, and permits concatenated padded blocks. Separate tests cover these differences, `--ignore-garbage`, and the terminal's explicit diagnostic for decoded bytes that cannot be represented as UTF-8.

The upstream pool's 50 randomly generated vectors are replaced by 50 deterministic byte sequences with all three remainder lengths, NUL, controls, and high bytes. These are analogous coverage, not the upstream random vectors. Upstream tests for JavaScript argument types, binary output containers, shared allocation, base64url APIs, and explicit library padding policies are outside the terminal command API and are not copied.

`byte-boundaries.json` adds independently precomputed vectors for bytes 0–255 in order and every one- and two-byte combination of 0, 127, 128, and 255. Tests also change every possible discarded-bit value of those shorter vectors and require the original payload with invalid-input status. These supplementary vectors are not copied from upstream.

All tests execute in process. They do not invoke native commands or use an external reference codec to compute expected results at test time.
