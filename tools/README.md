# tools/

`c8lab.py` is the organisers' lab client, vendored unchanged from
https://github.com/Cantor8/hackathon-toolkit (commit `4e83637`). Python 3, standard library only.

We use it for the demo's write side, which the scanner deliberately does not have: allocate a party,
set up a transfer preapproval, and send a Canton Coin transfer so the dashboard has something to catch.

```bash
export C8_BASE=https://api.validator.dev.digik.cantor8.tech/api/ledger
export C8_IDP=https://auth.dev.digik.cantor8.tech
export C8_CLIENT_ID=hackathon
export C8_CLIENT_SECRET=...            # same value as CLIENT_SECRET in ../.env
export C8_REGISTRY=https://sv-proxy.dev.digik.cantor8.tech   # Canton Coin registry on DevNet
export C8_USER=validator-backend@clients        # the DevNet ledger user; "ledger-api-user" is a LocalNet name
export C8_ADMIN_USER=validator-backend@clients

# Do NOT run `c8lab.py check` on DevNet: it walks every party on the participant (tens of thousands)
# and looks like a hang. Use holdings <party> instead.
python3 tools/c8lab.py holdings <party>
python3 tools/c8lab.py party lattice-scan-1
python3 tools/c8lab.py preapproval <party>
python3 tools/c8lab.py transfer <from> <to> 5      # then watch /updates/recent
python3 tools/c8lab.py accept <instructionCid> <to>  # if the transfer came back as an offer
```

DevNet can be slow under load. A call that hangs instead of returning an error is the network, not the code: retry it. The token lasts about 5 to 15 minutes depending on the identity provider's setting; `c8lab.py` caches it without an expiry, so re-run the command if you start seeing 401s.

Everything the scanner reads is documented in `../README.md`; the two agree on the token flow and on the
`Holding` interface id, so a balance shown by `c8lab.py holdings <party>` should equal
`GET /parties/{party}/balances`.
