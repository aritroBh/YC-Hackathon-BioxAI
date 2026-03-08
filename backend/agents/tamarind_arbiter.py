import asyncio
import os
import time
import httpx
from typing import Optional

TAMARIND_API_KEY = os.getenv("TAMARIND_API_KEY", "")
BASE = "https://app.tamarind.bio/api/"

COMPOUND_SMILES = {
    "sotorasib":  "CC1=CC(=C(C=C1)NC(=O)C2=CN=C(N=C2)NC3=CC(=C(C=C3)N4CC(C4)N(C)C(=O)/C=C/CN(C)C)F)F",
    "amg510":     "CC1=CC(=C(C=C1)NC(=O)C2=CN=C(N=C2)NC3=CC(=C(C=C3)N4CC(C4)N(C)C(=O)/C=C/CN(C)C)F)F",
    "adagrasib":  "C[C@@H]1CC[C@@H](C(=O)N2CC(=C)C[C@@H]2C3=C(C=CC(=N3)C4=NC5=CC=CC=C5N4C)Cl)O1",
    "mrtx849":    "C[C@@H]1CC[C@@H](C(=O)N2CC(=C)C[C@@H]2C3=C(C=CC(=N3)C4=NC5=CC=CC=C5N4C)Cl)O1",
    "ars1620":    "CC1=CC(=C(C(=C1)Cl)NC2=NC=C(C(=N2)NCC3=CC=C(C=C3)F)Cl)Cl",
    "ars-1620":   "CC1=CC(=C(C(=C1)Cl)NC2=NC=C(C(=N2)NCC3=CC=C(C=C3)F)Cl)Cl",
}

def normalize_compound(name: str) -> Optional[str]:
    if not name:
        return None
    n = name.lower().replace("-", "").replace(" ", "").replace("_", "")
    for key in COMPOUND_SMILES:
        k = key.replace("-", "")
        if k in n or n in k:
            return key
    return None

async def submit_diffdock(compound_key: str, job_name: str) -> bool:
    smiles = COMPOUND_SMILES.get(compound_key)
    if not smiles:
        return False
    payload = {
        "jobName": job_name,
        "type": "diffdock",
        "settings": {
            "proteinFile": "6OIM",
            "ligandFormat": "SMILES",
            "ligandSmiles": smiles,
        }
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{BASE}submit-job",
                headers={"x-api-key": TAMARIND_API_KEY},
                json=payload
            )
            if r.status_code == 200:
                print(f"Submitted: {job_name}")
                return True
            print(f"Submit failed {r.status_code}: {r.text}")
    except Exception as e:
        print(f"submit error: {e}")
    return False

async def poll_job(job_name: str, timeout: int = 180, interval: int = 10) -> Optional[dict]:
    deadline = time.time() + timeout
    async with httpx.AsyncClient(timeout=15) as client:
        while time.time() < deadline:
            try:
                r = await client.get(
                    f"{BASE}jobs",
                    headers={"x-api-key": TAMARIND_API_KEY},
                    params={"jobName": job_name}
                )
                if r.status_code == 200:
                    job = r.json()
                    if isinstance(job, list):
                        job = next((j for j in job if j.get("JobName") == job_name), None)
                    if job:
                        status = job.get("JobStatus", "")
                        print(f"  {job_name}: {status}")
                        if status == "Complete":
                            return job
                        if status in ("Stopped", "Deleted"):
                            return None
            except Exception as e:
                print(f"poll error: {e}")
            await asyncio.sleep(interval)
    print(f"Timeout: {job_name}")
    return None

async def get_confidence_score(job_name: str) -> Optional[float]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{BASE}result",
                headers={"x-api-key": TAMARIND_API_KEY},
                json={"jobName": job_name, "fileName": "confidence_scores.txt"}
            )
            if r.status_code == 200:
                url = r.text.strip().strip('"')
                if url.startswith("http"):
                    dl = await client.get(url, timeout=20)
                    if dl.status_code == 200:
                        scores = []
                        for line in dl.text.strip().split("\n"):
                            try:
                                scores.append(float(line.strip().split()[-1]))
                            except (ValueError, IndexError):
                                pass
                        if scores:
                            return max(scores)
    except Exception as e:
        print(f"result error: {e}")
    return None

def build_verdict(comp_a, score_a, comp_b, score_b) -> dict:
    def label(s):
        if s is None: return "no data"
        if s > -1.0: return "strong binding"
        if s > -2.5: return "moderate binding"
        return "weak binding"

    if score_a is not None and score_b is None:
        if score_a > -1.5:
            return {
                "verdict": "node_a_supported",
                "structural_rationale": f"DiffDock predicts confident binding of {comp_a} against KRAS G12C (6OIM) — confidence score {score_a:.2f} ({label(score_a)}). This structural evidence supports the high-potency claim in node A over the discrepant private assay value.",
                "confidence": 0.75,
            }
        else:
            return {
                "verdict": "node_b_supported",
                "structural_rationale": f"DiffDock predicts {label(score_a)} for {comp_a} against KRAS G12C (confidence {score_a:.2f}). This is more consistent with the higher IC50 values observed in the private assay data.",
                "confidence": 0.65,
            }

    if score_a is not None and score_b is not None:
        if abs(score_a - score_b) < 0.5:
            return {
                "verdict": "both_plausible",
                "structural_rationale": f"DiffDock predicts similar binding confidence for {comp_a} ({score_a:.2f}) and {comp_b} ({score_b:.2f}) against KRAS G12C. The IC50 discrepancy likely reflects assay conditions rather than a true potency difference.",
                "confidence": 0.60,
            }
        winner = comp_a if score_a > score_b else comp_b
        loser = comp_b if score_a > score_b else comp_a
        ws = max(score_a, score_b)
        ls = min(score_a, score_b)
        node_supported = "node_a_supported" if score_a > score_b else "node_b_supported"
        return {
            "verdict": node_supported,
            "structural_rationale": f"DiffDock predicts stronger binding for {winner} (confidence {ws:.2f}) vs {loser} ({ls:.2f}) against KRAS G12C (6OIM). This supports the higher potency claim for {winner}.",
            "confidence": 0.78,
        }

    return {
        "verdict": "inconclusive",
        "structural_rationale": "DiffDock did not return usable scores for this pair.",
        "confidence": 0.0,
    }

async def run_tamarind_arbiter(node_a, node_b) -> dict:
    comp_a = normalize_compound(node_a.subject_name) or normalize_compound(node_a.object_name)
    comp_b = normalize_compound(node_b.subject_name) or normalize_compound(node_b.object_name)
    if comp_b == comp_a:
        comp_b = None

    skipped = {
        "verdict": "skipped",
        "structural_rationale": "No KRAS G12C inhibitor detected in this contradiction pair.",
        "confidence": 0.0,
        "tamarind_job_id": None,
        "binding_affinity_a": None,
        "binding_affinity_b": None,
        "compound_a": comp_a,
        "compound_b": comp_b,
        "mock": False,
    }

    # MOCK MODE — works without API key, shows realistic demo verdict
    if not TAMARIND_API_KEY:
        if not comp_a:
            return skipped
        return {
            "verdict": "node_b_supported",
            "structural_rationale": f"DiffDock structural docking of {comp_a or 'sotorasib'} against KRAS G12C (6OIM) predicts moderate binding confidence (score: -1.42). This is more consistent with the higher IC50 values in the private assay data than the sub-nanomolar values reported in published literature. The Switch II pocket geometry may be altered under your assay conditions.",
            "confidence": 0.74,
            "tamarind_job_id": "dialectic-mock-demo",
            "binding_affinity_a": -1.42,
            "binding_affinity_b": -2.81 if comp_b else None,
            "compound_a": comp_a or "sotorasib",
            "compound_b": comp_b,
            "mock": True,
        }

    if not comp_a:
        return skipped

    ts = int(time.time())
    jobs = {}
    for side, compound in [("a", comp_a), ("b", comp_b)]:
        if not compound:
            continue
        jname = f"dialectic-{compound}-{ts}-{side}"
        jname = jname.replace(".", "").replace("(", "").replace(")", "")
        if await submit_diffdock(compound, jname):
            jobs[side] = (jname, compound)

    if not jobs:
        return {**skipped, "structural_rationale": "DiffDock job submission failed."}

    poll_results = await asyncio.gather(*[poll_job(jn) for jn, _ in jobs.values()])

    scores = {}
    best_job = None
    for i, (side, (jname, compound)) in enumerate(jobs.items()):
        if poll_results[i]:
            score = await get_confidence_score(jname)
            scores[side] = (score, compound, jname)
            if best_job is None:
                best_job = jname

    if not scores:
        return {**skipped, "structural_rationale": "DiffDock did not complete in time."}

    sa_tuple = scores.get("a", (None, comp_a, None))
    sb_tuple = scores.get("b", (None, comp_b, None))
    score_a, compound_a, _ = sa_tuple
    score_b, compound_b, _ = sb_tuple

    verdict_core = build_verdict(compound_a, score_a, compound_b, score_b)

    return {
        **verdict_core,
        "tamarind_job_id": best_job,
        "binding_affinity_a": score_a,
        "binding_affinity_b": score_b,
        "compound_a": compound_a,
        "compound_b": compound_b,
        "mock": False,
    }
