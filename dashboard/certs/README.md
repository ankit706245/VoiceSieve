# Supabase pooler CA

`supabase-pooler-ca.pem` is the public root certificate presented by the
Supabase session pooler (`aws-0-ap-northeast-1.pooler.supabase.com`). It was
extracted from the pooler's TLS chain on 2026-10-24 and is used only to verify
the pooler certificate when `DOGRAH_DB_SSL=verify-full`.

This is a public CA certificate, not a secret. The server certificate's SAN is
`*.pooler.supabase.com`, which matches the configured pooler host.
