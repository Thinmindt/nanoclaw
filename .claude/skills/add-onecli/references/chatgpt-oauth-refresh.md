# ChatGPT OAuth refresh with OneCLI

These notes apply to the current OneCLI credential adapter, not to any
provider's runtime contract.

NanoClaw's OneCLI 1.42.0 pin cannot refresh the ChatGPT OAuth credentials a
provider imports (Codex's or OpenCode's ChatGPT sign-in): its refresh request
omits the required client ID, and OpenAI answers 400. The access token then
stops working about ten days after each sign-in. After expiry, use the
provider's manual reauthentication:

- Codex: [Recover a ChatGPT login](../../add-codex/SKILL.md#recover-a-chatgpt-login)
  (`pnpm exec tsx scripts/codex-auth.ts --reauth`).
- OpenCode: [Recover a ChatGPT login](../../add-opencode/SKILL.md#recover-a-chatgpt-login)
  (`pnpm exec tsx scripts/opencode-auth.ts --reauth`).

Both replace the stored login's value under its existing id, so agent grants
are kept. The value they store is the adapter's encoding (access token, refresh
token and account id), not Codex's whole `auth.json`. OneCLI is expected to
rederive the entry's `metadata.authMode` and `metadata.accountId` from that
value; the gateway does not document this, and it is unproven for this shape
until a live re-sign-in shows the metadata unchanged and a freshly spawned agent
gets no placeholder account id warning. The same procedures also handle revoked
credentials.

Do not assume a gateway upgrade resolves unattended ChatGPT operation.
OneCLI 1.43 and later remove the agent-grant API used by this NanoClaw version, so
that upgrade also requires an integration migration and validation of token refresh.
A different proxy is not established as compatible by these tests.

The container holds only a fixed non-secret sentinel. Token refresh and account
metadata remain gateway responsibilities; never work around refresh failures by
copying live credentials into a group. Remove this version-specific note once
the replacement integration and refresh behavior have been verified.
