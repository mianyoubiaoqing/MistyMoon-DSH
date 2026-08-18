# RP interoperability fixtures

All files in this directory are generated, neutral, and public. They contain no
real Persona, relationship, memory, conversation, credential, local path, or
third-party artwork.

- `character-v2.json` and `character-v3.json` exercise inert Character Card
  parsing and unknown-extension preservation.
- `character-v3.charx.b64` is a base64-encoded CHARX ZIP whose sole root entry
  is the neutral `character-v3.json`; tests decode it only into a system temp
  directory.
- Owner Persona and Relationship are separate documents to prove that importing
  a Character cannot replace either authority.
- Worldbook, speaker-policy, summary, and scope files are expected receipts and
  revision inputs, not model instructions.

Unknown extension fields must round-trip inside a private draft extension area
and never become system-prompt authority without a separate reviewed mapping.
