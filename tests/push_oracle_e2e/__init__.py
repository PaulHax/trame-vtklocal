"""End-to-end Playwright oracle for push sync v2.

The companion in-process oracle (``tests/test_v2_oracle.py``) proves the
``ScenePublisher`` protocol against a normative Python mirror client. This
package drives the full production stack — real wslink broadcasts, the real
client engine (mirror store + reconcile applier) — and compares the
client's reconstructed scene against the server's scene-store snapshot
after each oracle step.
"""
