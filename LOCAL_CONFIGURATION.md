# Local configuration and captured data

Use `.env.example` as the configuration reference. Copy it to an ignored `.env`
and supply your own runtime values; never copy the real `.env` back into the
example. Keep authentication tokens, passwords and account identifiers out of
commits, issue reports and screenshots, even when a capture is only for debugging.

Captured headers (`headers_dump*.txt`), logs, operational databases and runtime
data are local artifacts. Their exclusion does not stop scripts from generating
them locally and does not delete files already present on your machine.

Do not paste real tokens into tests. Use unmistakably synthetic fixtures when
testing code that handles authentication. Do not test exposed tokens against
providers. Removing an artifact from the current Git index does not remove its
history, prove that a token was private, or revoke any previously exposed secret.
