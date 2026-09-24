"""Opt-in real-engine acceptance run against an already parsed local demo.

Run with CS2_INSIGHT_DATA_DIR set to the intended app data directory.
Starts the normal API/GSI server and the actual five-player render pipeline.
"""
import asyncio
import json
import logging
import os
import sqlite3

import uvicorn

from app.env_utils import get_data_dir
from app.features.tactical_playbook.api import RoundSelection, prepare_povs, _batches


async def main():
    os.environ["CS2_INSIGHT_PORT"] = "19871"
    logging.basicConfig(level=logging.INFO)
    with sqlite3.connect(f"file:{(get_data_dir() / 'cs2-insight.db').as_posix()}?mode=ro", uri=True) as db:
        row = db.execute("SELECT demo_path, result_json FROM match_results ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        raise RuntimeError("Import and parse a real demo first")
    workspace = json.loads(row[1])["analysis_workspace"]
    selected_round = workspace["rounds"][0]["round_number"]
    server = uvicorn.Server(uvicorn.Config("app.main:app", host="127.0.0.1", port=19871, log_level="warning"))
    server_task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            if server_task.done():
                await server_task
                raise RuntimeError("API server did not start")
            await asyncio.sleep(0.1)
        state = await prepare_povs(RoundSelection(demo_path=row[0], analysis_workspace=workspace,
                                                 round_number=selected_round, side="T"))
        previous = None
        while True:
            state = _batches[state["id"]]
            summary = json.dumps(state, ensure_ascii=True)
            if summary != previous:
                print(summary, flush=True)
                previous = summary
            if state["status"] in {"Complete", "Failed"}:
                break
            await asyncio.sleep(1)
        if state["status"] != "Complete" or len(state["players"]) != 5:
            raise RuntimeError("Real five-POV acceptance failed; inspect batch metadata and engine logs")
    finally:
        server.should_exit = True
        await server_task


if __name__ == "__main__":
    asyncio.run(main())
