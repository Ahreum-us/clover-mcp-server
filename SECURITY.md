# Security

## Credential handling — read this before deploying

This server authenticates to Clover using credentials supplied through
**environment variables** (`CLOVER_ACCESS_TOKEN`, `CLOVER_MERCHANT_ID`).

That is convenient for local development and sandbox evaluation, but understand
what it means before running it against a live merchant:

- In a typical `.env` or `docker-compose` setup, these secrets are stored
  **in plaintext on disk**.
- Anything that can read that file or the process environment — an accidental
  `git add`, a backup, a shared volume, another process on the host, or a
  compromised machine — can read your credentials.
- These credentials grant access to live merchant and order data. Treat them
  with the same care as a password.

**This server does not include a secret-management layer.** As shipped, it
trusts you to supply credentials securely. For any deployment touching real
merchant data, we strongly recommend resolving credentials at runtime from a
dedicated secrets manager rather than reading them from a plaintext env file.

## Recommended hardening

At minimum:
- Never commit your `.env`. Confirm it is listed in `.gitignore`.
- Restrict permissions: `chmod 600 .env`.
- Prefer Docker or systemd secrets over a plaintext env file where possible.

Better — resolve secrets at runtime from a managed store. Viable options,
roughly from lightest-weight to heaviest:

- **1Password CLI (service account)** — store each credential as a vault item
  and read it at startup via `op read "op://Vault/item/field"`. Rotation becomes
  a vault edit with no redeploy.
- **Doppler / Infisical** — managed secrets-as-a-service with simple runtime
  injection and good developer ergonomics.
- **HashiCorp Vault** — open-source, self-hostable; the option for teams needing
  dynamic secrets and audit logging.
- **Cloud secret managers** — AWS Secrets Manager, GCP Secret Manager, or Azure
  Key Vault if you already run in that cloud.
- **SOPS + age/KMS** — if you prefer encrypted secrets committed to git,
  decrypted only at deploy time.

The common thread: the secret should live somewhere access-controlled and
auditable, and reach the process in memory at runtime — not sit in plaintext
on disk.
