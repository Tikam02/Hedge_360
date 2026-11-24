"""
Writes the analytics API's answers as JSON files for the GitHub Pages build of the web app, which has no server.

    python export_static.py web/public/derivs

One file per request the web app makes: health.json, sectors.json, symbols.json, chain/<SYMBOL>.json (nearest
expiry), chain/<SYMBOL>/<EXPIRY>.json and surface/<SYMBOL>.json. web/lib/derivs.ts asks for these files instead of
the API when NEXT_PUBLIC_DERIVS_STATIC is set; both sides turn anything but letters, digits and "-" in a name into
"_" (M&M is chain/M_M.json).
"""

import json
import re
import sys
from pathlib import Path

import derivs


def safe(name):
    return re.sub(r"[^A-Za-z0-9-]", "_", name)


def main(out):
    out = Path(out)

    def put(rel, data):
        f = out / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(data, separators=(",", ":")))

    put("health.json", derivs.health())
    put("sectors.json", derivs.sectors())
    syms = derivs.symbols()
    put("symbols.json", syms)
    for s in syms["symbols"]:
        sym = safe(s["symbol"])
        put(f"chain/{sym}.json", derivs.chain(s["symbol"], None))
        for e in s["expiries"]:
            put(f"chain/{sym}/{safe(e)}.json", derivs.chain(s["symbol"], e))
        put(f"surface/{sym}.json", derivs.surface(s["symbol"]))
    print(f"Wrote {sum(1 for _ in out.rglob('*.json'))} files to {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "web/public/derivs")
