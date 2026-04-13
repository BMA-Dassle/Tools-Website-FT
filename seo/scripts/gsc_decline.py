"""Compare last 28d vs prior 28d, flag declining queries for each property.

Outputs to seo/reports/decline-YYYY-MM-DD.txt and prints to stdout.

Classification buckets (from README):
  1. Seasonal: impressions down, position stable -> do nothing
  2. CTR drop at rank: clicks down, impressions up, position stable -> fix GBP
  3. Real rank drop: position worsened 3+ -> fix landing page
  4. SERP feature loss: position improved but clicks dropped -> fix GBP
"""
import os
import sys
from datetime import date, timedelta

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(__file__))
from _common import client, list_sites

svc = client(write=False)
sites = list_sites(svc)


def fetch_queries(site, start, end, row_limit=5000):
    body = {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "dimensions": ["query"],
        "rowLimit": row_limit,
    }
    try:
        r = svc.searchanalytics().query(siteUrl=site, body=body).execute()
        return {row["keys"][0]: row for row in r.get("rows", [])}
    except Exception as e:
        print(f"  ERROR for {site}: {e}")
        return {}


def classify(d):
    if d["pos_delta"] > 3:
        return "RANK-DROP"
    if d["imp_delta"] < 0 and abs(d["pos_delta"]) < 1:
        return "SEASONAL"
    if d["click_delta"] < 0 and d["imp_delta"] > 0 and abs(d["pos_delta"]) < 1:
        return "CTR-DROP"
    if d["pos_delta"] < -1 and d["click_delta"] < 0:
        return "SERP-FEATURE"
    return "MIXED"


today = date.today()
cur_end = today - timedelta(days=3)
cur_start = cur_end - timedelta(days=27)
prev_end = cur_start - timedelta(days=1)
prev_start = prev_end - timedelta(days=27)

report = []
report.append(f"GSC Decline Report — generated {today.isoformat()}")
report.append(f"Current period:  {cur_start} .. {cur_end}")
report.append(f"Previous period: {prev_start} .. {prev_end}")
report.append("")

for site in sites:
    report.append(f"=== {site} ===")
    cur = fetch_queries(site, cur_start, cur_end)
    prev = fetch_queries(site, prev_start, prev_end)

    declines = []
    for q, prev_row in prev.items():
        cur_row = cur.get(q)
        prev_clicks = prev_row["clicks"]
        cur_clicks = cur_row["clicks"] if cur_row else 0
        prev_imps = prev_row["impressions"]
        cur_imps = cur_row["impressions"] if cur_row else 0
        prev_pos = prev_row["position"]
        cur_pos = cur_row["position"] if cur_row else 100
        if prev_imps < 20:
            continue
        d = {
            "q": q,
            "prev_clicks": prev_clicks, "cur_clicks": cur_clicks,
            "click_delta": cur_clicks - prev_clicks,
            "prev_imps": prev_imps, "cur_imps": cur_imps,
            "imp_delta": cur_imps - prev_imps,
            "prev_pos": round(prev_pos, 1), "cur_pos": round(cur_pos, 1),
            "pos_delta": round(cur_pos - prev_pos, 1),
        }
        if d["click_delta"] < -2 or (d["imp_delta"] < -30 and prev_imps > 50) or d["pos_delta"] > 3:
            d["bucket"] = classify(d)
            declines.append(d)

    declines.sort(key=lambda d: d["click_delta"])
    report.append(f"  {len(prev)} prev queries, {len(cur)} cur queries, {len(declines)} declining")
    report.append("")
    # Group by bucket
    from collections import defaultdict
    by_bucket = defaultdict(list)
    for d in declines:
        by_bucket[d["bucket"]].append(d)

    for bucket in ["RANK-DROP", "CTR-DROP", "SERP-FEATURE", "SEASONAL", "MIXED"]:
        items = by_bucket.get(bucket, [])
        if not items:
            continue
        report.append(f"  --- {bucket} ({len(items)}) ---")
        report.append(f"  {'Query':<45} {'Clicks':>16} {'Imps':>16} {'Position':>14}")
        for d in items[:25]:
            q = d["q"][:44]
            report.append(
                f"  {q:<45} "
                f"{d['prev_clicks']:>4}->{d['cur_clicks']:<4} {d['click_delta']:+4}  "
                f"{d['prev_imps']:>5}->{d['cur_imps']:<5} {d['imp_delta']:+5}  "
                f"{d['prev_pos']:>5}->{d['cur_pos']:<5} {d['pos_delta']:+5.1f}"
            )
        report.append("")
    report.append("")

out = "\n".join(report)
print(out)

# Save
reports_dir = os.path.join(os.path.dirname(__file__), "..", "reports")
os.makedirs(reports_dir, exist_ok=True)
path = os.path.join(reports_dir, f"decline-{today.isoformat()}.txt")
with open(path, "w", encoding="utf-8") as f:
    f.write(out)
print(f"\nSaved: {path}")
