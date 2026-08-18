# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ |

## Reporting a Vulnerability

The project uses browser automation with stored cookies and API keys. If you discover a security vulnerability, please report it privately.

**Do not** open a public issue. Instead, email the project maintainers or open a draft security advisory on GitHub.

## Security Best Practices

- Keep your `API_KEY` secret — never commit it
- The `shared/.api_key` and `shared/.encryption.key` files are auto-generated and excluded from git
- Browser profiles with stored cookies are excluded from git (`shared/browser_profile/`)
- In production, run with `NODE_ENV=production` and bind to `127.0.0.1` only
- Set a strong `API_KEY` when exposing the server beyond localhost
