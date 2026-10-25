# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Include the version (`fuguruma version`), how
to reproduce the issue and its impact. You should get a first response within
a couple of weeks.

脆弱性を見つけた場合は公開の Issue ではなく、リポジトリの **Security** タブの
**Report a vulnerability** から非公開で報告してください。

## Supported versions

Only the latest release receives security fixes.

## Deployment notes

- Set a login password (`fuguruma passwd`) before exposing the server beyond
  your own machine, and put it behind HTTPS (e.g. Caddy) when reachable from
  the internet.
- The config file contains API keys and is written with mode `0600`; keep it
  readable only by the service user.
