"""Sync policy: decides, per memory, whether it stays on the device or becomes
shared fleet knowledge in the cloud.

  - Frame memories (raw full-frame imagery) never leave the device: they are
    the heaviest and most privacy-sensitive data, and the object memories
    already carry what the fleet needs to know.
  - Objects seen in sensitive rooms (bathroom, bedroom) stay local while the
    privacy rule is on. An operator can still share one explicitly.
  - Every other object memory syncs: embedding, caption, crop, annotations.
"""

from .constants import PRIVATE_CLASSES


class SyncPolicy:
    def __init__(self):
        self.privacy_rule = True
        self.conflict_mode = "manual"   # manual | latest

    def classify(self, kind: str, cls: str | None) -> tuple[str, str]:
        if kind == "frame":
            return "local", "raw frame imagery stays on device"
        if self.privacy_rule and cls in PRIVATE_CLASSES:
            return "local", "privacy rule: sensitive area"
        return "sync", "object knowledge shared with fleet"

    def to_dict(self) -> dict:
        return {
            "privacy_rule": self.privacy_rule,
            "conflict_mode": self.conflict_mode,
            "private_classes": sorted(PRIVATE_CLASSES),
        }
