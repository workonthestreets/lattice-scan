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

python3 tools/c8lab.py check
python3 tools/c8lab.py party lattice-scan-1
python3 tools/c8lab.py preapproval <party>
python3 tools/c8lab.py transfer <from> <to> 5      # then watch /updates/recent
python3 tools/c8lab.py accept <instructionCid> <to>  # if the transfer came back as an offer
```

Everything the scanner reads is documented in `../README.md`; the two agree on the token flow and on the
`Holding` interface id, so a balance shown by `c8lab.py holdings <party>` should equal
`GET /parties/{party}/balances`.
