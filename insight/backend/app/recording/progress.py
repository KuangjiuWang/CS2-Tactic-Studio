"""Task-local recording progress, shared by engine and tactical batch."""
from contextvars import ContextVar
import logging

recording_progress_observer = ContextVar("recording_progress_observer", default=None)
require_verified_pov = ContextVar("require_verified_pov", default=False)


def report_progress(status: str, request_id: str | None = None) -> None:
    observer = recording_progress_observer.get()
    if observer is not None:
        try:
            observer(status, request_id)
        except Exception:
            logging.getLogger(__name__).exception("Recording progress observer failed")
