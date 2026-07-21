# Security Policy

## Supported versions

Only the current major line gets security fixes. There's no long-term support branch, and there won't be one until someone actually needs it.

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| < 1.0 | No |

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/svyatov/devto-client/security/advisories/new). It opens a private thread between you and the maintainer, so nothing is public until there's a fix to publish alongside the disclosure.

Please don't open a public issue for anything you believe is exploitable.

You'll get a first response within 7 days. If a report turns out to be valid, expect a patched release and a published advisory once the fix is out; if it doesn't, you'll get an explanation of why rather than silence.

## What counts

The client has zero runtime dependencies, so the realistic surface is its own request handling: how it builds URLs and query strings, what it does with headers and the API key, how it parses and surfaces responses, and what ends up in error messages. Credential leakage into logs or thrown errors is in scope. So is anything that lets a crafted API response change control flow in a caller's process.

The dev.to API itself is not in scope here. Report those to [Forem](https://github.com/forem/forem/security/policy).
