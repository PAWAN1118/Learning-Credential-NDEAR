# Local signed issuer demo

This small Node service demonstrates the wallet's verification flow without an
institution API. It creates three visibly labelled demo issuers, each with an
independent `did:key` Ed25519 key. It issues one signed Open Badges 3.0 credential and exports it as five
representations: JSON VC, JSON-LD VC, Open Badges 3.0, a PNG-baked badge, and a
JWT VC (`vc+jwt`). It publishes the issuer registry and DID documents, generates
wallet import QR codes, and provides a Bitstring Status List for revocation.

## Run locally

From the repository root:

```sh
npm install
npm run demo:issuer
```

Open `http://127.0.0.1:4170`. The terminal prints a temporary issuer admin
token. Enter that token to issue or revoke demo credentials. Issuer keys and
demo credential data are stored in the ignored `.issuer-demo-data/` directory.
The demo UI asks for demo learner data only.

For a phone on the same Wi-Fi, bind a LAN origin so credential IDs are
reachable from the APK:

```sh
# PowerShell example
$env:HOST='0.0.0.0'
$env:ISSUER_DEMO_PUBLIC_URL='http://192.168.1.10:4170'
npm run demo:issuer
```

Then in the wallet: **Settings → Connected Universities** and save
`http://192.168.1.10:4170/api/registry.json`. You can also set
`EXPO_PUBLIC_NDEAR_DEMO_REGISTRY_URL` to that URL before a native rebuild.
`ISSUER_DEMO_PUBLIC_URL` must be the same origin the phone will fetch.
Importing a credential does not by itself make its issuer trusted.

## Institution verification API

Institutions can submit any W3C Verifiable Credential JSON object for a
cryptographic proof, issuer, and credential-status check:

```http
POST /api/verify
Content-Type: application/json

{"credential": {"type": ["VerifiableCredential"], "...": "..."}}
```

The response contains `verified`, individual `checks`, the credential ID, and
`revoked` when the credential was issued by this demo service. Malformed
credentials return HTTP 400. A credential is considered verified only when
all required checks pass. `GET /api/verify/:credentialId` remains available
for credentials issued by this service.

The three issuer profiles let the integration test exercise independent issuer
keys. They are demo organizations, not production connections to real
education platforms. A real institutional integration needs that provider's
authorized API access and issuer keys.

## Scope and deployment

The service signs one Open Badges 3.0 W3C Verifiable Credential with a JSON-LD
Data Integrity proof, then exports that same signed object as JSON, JSON-LD,
Open Badges 3.0, a PNG with an `openbadgecredential` chunk, and an EdDSA
`vc+jwt` envelope. The wallet imports all five, verifies the proof (and the JWT
envelope when present), and only then stores, shares, or recommends from it.

All three issuers are fictional demo identities. This is a teaching prototype,
not a production issuer. Before deployment, replace local JSON storage with a
durable database, protect signing keys with a managed secret or HSM, add real
user authentication and authorization, configure HTTPS and a restricted CORS
origin, and establish how genuine institutions authorize issuance. Do not
represent the demo issuers as real institutions or their credentials as
institutionally verified.
