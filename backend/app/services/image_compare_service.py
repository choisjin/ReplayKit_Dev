"""Image comparison service — SSIM, ROI, template matching, exclusion, multi-crop."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

def _clean_path_for_cv2():
    """Remove conflicting Python directories from PATH before loading cv2.

    When multiple Python installations (especially 32-bit ones like Python27)
    exist in PATH, Windows may load incompatible DLLs causing cv2 to fail with
    'not a valid Win32 application' error.
    """
    import os
    conflicting = ("python27", "python37", "python38")
    original = os.environ.get("PATH", "")
    cleaned = ";".join(
        p for p in original.split(";")
        if not any(c in p.lower() for c in conflicting)
    )
    os.environ["PATH"] = cleaned
    return original


try:
    _original_path = _clean_path_for_cv2()
    import cv2
    import numpy as np
    from skimage.metrics import structural_similarity as ssim
    _CV2_AVAILABLE = True
except (ImportError, OSError) as _cv2_err:
    _CV2_AVAILABLE = False
    cv2 = None  # type: ignore
    np = None  # type: ignore
    ssim = None  # type: ignore
finally:
    # Restore original PATH so other processes are not affected
    import os as _os
    if "_original_path" in dir():
        _os.environ["PATH"] = _original_path  # type: ignore

logger = logging.getLogger(__name__)


class ImageCompareService:
    """Compare expected vs actual screenshots."""

    @staticmethod
    def _require_cv2():
        if not _CV2_AVAILABLE:
            raise RuntimeError(
                "opencv-python is not installed or failed to load. "
                "Install it with: pip install opencv-python-headless"
            )

    # ------------------------------------------------------------------
    # Level 1 — Full-image SSIM
    # ------------------------------------------------------------------

    def compare_ssim(
        self,
        expected_path: str,
        actual_path: str,
        roi: Optional[dict] = None,
    ) -> dict:
        """Return similarity score and diff image path.

        Args:
            expected_path: path to expected screenshot PNG
            actual_path: path to actual screenshot PNG
            roi: optional dict with x, y, width, height to crop before comparing
        """
        self._require_cv2()
        img_exp = cv2.imread(expected_path)
        img_act = cv2.imread(actual_path)
        if img_exp is None or img_act is None:
            return {"score": 0.0, "error": "Could not read one or both images"}

        # Apply ROI crop if specified
        if roi:
            x, y, w, h = roi["x"], roi["y"], roi["width"], roi["height"]
            img_exp = img_exp[y : y + h, x : x + w]
            img_act = img_act[y : y + h, x : x + w]

        # If expected image is smaller than actual (cropped expected image),
        # extract the matching region from actual via template matching.
        eh, ew = img_exp.shape[:2]
        ah, aw = img_act.shape[:2]
        if eh < ah or ew < aw:
            return self._compare_cropped(img_exp, img_act)

        # Resize actual to match expected if needed (e.g. slight resolution diff)
        if img_exp.shape != img_act.shape:
            img_act = cv2.resize(img_act, (img_exp.shape[1], img_exp.shape[0]))

        # Convert to grayscale for SSIM
        gray_exp = cv2.cvtColor(img_exp, cv2.COLOR_BGR2GRAY)
        gray_act = cv2.cvtColor(img_act, cv2.COLOR_BGR2GRAY)

        score, diff = ssim(gray_exp, gray_act, full=True)
        diff_uint8 = (diff * 255).astype("uint8")

        return {
            "score": round(float(score), 4),
            "diff_array": diff_uint8,
        }

    def _compare_cropped(self, img_exp: np.ndarray, img_act: np.ndarray) -> dict:
        """Compare a cropped expected image against a full actual screenshot.

        Uses template matching to locate the region, then SSIM on the matched area.
        """
        gray_exp = cv2.cvtColor(img_exp, cv2.COLOR_BGR2GRAY)
        gray_act = cv2.cvtColor(img_act, cv2.COLOR_BGR2GRAY)

        # Template match to find the best location
        result = cv2.matchTemplate(gray_act, gray_exp, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        # Crop actual image at the matched location
        eh, ew = img_exp.shape[:2]
        x, y = max_loc
        matched_region = gray_act[y:y + eh, x:x + ew]

        # Compute SSIM on the matched region
        score, diff = ssim(gray_exp, matched_region, full=True)
        diff_uint8 = (diff * 255).astype("uint8")

        logger.info(
            "Cropped comparison: template_confidence=%.4f, ssim=%.4f, location=(%d,%d)",
            max_val, score, x, y,
        )

        return {
            "score": round(float(score), 4),
            "diff_array": diff_uint8,
            "match_location": {"x": int(x), "y": int(y), "width": int(ew), "height": int(eh)},
            "template_confidence": round(float(max_val), 4),
        }

    # ------------------------------------------------------------------
    # Full-image SSIM with exclusion regions
    # ------------------------------------------------------------------

    def compare_ssim_with_exclusions(
        self,
        expected_path: str,
        actual_path: str,
        exclude_rois: list[dict],
    ) -> dict:
        """SSIM comparison with specified regions excluded.

        Computes per-pixel SSIM, masks out excluded regions, and averages
        only the unmasked pixels for the final score.
        """
        self._require_cv2()
        img_exp = cv2.imread(expected_path)
        img_act = cv2.imread(actual_path)
        if img_exp is None or img_act is None:
            return {"score": 0.0, "error": "Could not read one or both images"}

        if img_exp.shape != img_act.shape:
            img_act = cv2.resize(img_act, (img_exp.shape[1], img_exp.shape[0]))

        gray_exp = cv2.cvtColor(img_exp, cv2.COLOR_BGR2GRAY)
        gray_act = cv2.cvtColor(img_act, cv2.COLOR_BGR2GRAY)

        # Compute full SSIM map
        _, diff = ssim(gray_exp, gray_act, full=True)

        # Build inclusion mask (True = include, False = exclude)
        h, w = diff.shape
        mask = np.ones((h, w), dtype=bool)
        for roi in exclude_rois:
            rx, ry = roi["x"], roi["y"]
            rw, rh = roi["width"], roi["height"]
            mask[ry:ry + rh, rx:rx + rw] = False

        # Average SSIM only over included pixels
        if mask.sum() == 0:
            score = 1.0  # nothing to compare
        else:
            score = float(diff[mask].mean())

        # Build diff array with excluded regions zeroed out (shown as identical)
        diff_uint8 = (diff * 255).astype("uint8")
        diff_uint8[~mask] = 255  # mark excluded as "identical" in diff

        logger.info(
            "Exclusion comparison: %d regions excluded, score=%.4f",
            len(exclude_rois), score,
        )

        return {
            "score": round(score, 4),
            "diff_array": diff_uint8,
            "exclude_rois": exclude_rois,
        }

    # ------------------------------------------------------------------
    # Multi-crop comparison
    # ------------------------------------------------------------------

    def compare_multi_crop(
        self,
        actual_path: str,
        crop_items: list[dict],
        threshold_pass: float = 0.95,
        threshold_warning: float = 0.85,
    ) -> dict:
        """Compare multiple cropped expected images against a single actual screenshot.

        Returns per-crop sub-results. Overall status is fail if any crop fails.
        """
        self._require_cv2()
        img_act = cv2.imread(actual_path)
        if img_act is None:
            return {"error": "Could not read actual image", "sub_results": []}

        sub_results = []

        for item in crop_items:
            img_exp = cv2.imread(item["image"])
            if img_exp is None:
                sub_results.append({
                    "label": item.get("label", ""),
                    "expected_image": item.get("rel_path", ""),
                    "score": 0.0,
                    "status": "error",
                    "match_location": None,
                })
                continue

            result = self._compare_cropped(img_exp, img_act)
            score = result["score"]

            if score >= threshold_pass:
                status = "pass"
            elif score >= threshold_warning:
                status = "warning"
            else:
                status = "fail"

            sub_results.append({
                "label": item.get("label", ""),
                "expected_image": item.get("rel_path", ""),
                "score": score,
                "status": status,
                "match_location": result.get("match_location"),
            })

        logger.info(
            "Multi-crop comparison: %d crops, results=%s",
            len(crop_items),
            [(sr["label"] or f"#{i}", sr["status"], sr["score"]) for i, sr in enumerate(sub_results)],
        )

        return {"sub_results": sub_results}

    # ------------------------------------------------------------------
    # Level 2 — SSIM with status-bar masking
    # ------------------------------------------------------------------

    def compare_ssim_masked(
        self,
        expected_path: str,
        actual_path: str,
        mask_top_px: int = 80,
    ) -> dict:
        """SSIM comparison with top status bar masked out."""
        return self.compare_ssim(
            expected_path,
            actual_path,
            roi=None,  # masking is applied below
        )

    # ------------------------------------------------------------------
    # Level 3 — Template matching
    # ------------------------------------------------------------------

    def template_match(
        self,
        screenshot_path: str,
        template_path: str,
        threshold: float = 0.8,
    ) -> dict:
        """Check if a template image exists within a screenshot.

        Returns location and confidence score.
        """
        self._require_cv2()
        img = cv2.imread(screenshot_path)
        tmpl = cv2.imread(template_path)
        if img is None or tmpl is None:
            return {"found": False, "error": "Could not read one or both images"}

        img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        tmpl_gray = cv2.cvtColor(tmpl, cv2.COLOR_BGR2GRAY)

        result = cv2.matchTemplate(img_gray, tmpl_gray, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        found = float(max_val) >= threshold
        return {
            "found": found,
            "confidence": round(float(max_val), 4),
            "location": {"x": int(max_loc[0]), "y": int(max_loc[1])} if found else None,
        }

    # ------------------------------------------------------------------
    # Diff heatmap generation
    # ------------------------------------------------------------------

    def generate_diff_heatmap(
        self,
        expected_path: str,
        actual_path: str,
        output_path: str,
        roi: Optional[dict] = None,
        exclude_rois: Optional[list[dict]] = None,
    ) -> str:
        """Generate a heatmap PNG highlighting differences."""
        if exclude_rois:
            result = self.compare_ssim_with_exclusions(expected_path, actual_path, exclude_rois)
        else:
            result = self.compare_ssim(expected_path, actual_path, roi=roi)
        if "error" in result:
            raise RuntimeError(result["error"])

        diff = result["diff_array"]
        # Invert so differences are bright
        diff_inv = 255 - diff
        heatmap = cv2.applyColorMap(diff_inv, cv2.COLORMAP_JET)

        # Gray out excluded regions in heatmap
        if exclude_rois:
            for roi_r in exclude_rois:
                rx, ry = roi_r["x"], roi_r["y"]
                rw, rh = roi_r["width"], roi_r["height"]
                heatmap[ry:ry + rh, rx:rx + rw] = (128, 128, 128)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(output_path, heatmap)
        return output_path

    def generate_multi_crop_annotated(
        self,
        actual_path: str,
        sub_results: list[dict],
        output_path: str,
    ) -> str:
        """Draw match boxes for each crop on the actual screenshot."""
        img = cv2.imread(actual_path)
        if img is None:
            raise RuntimeError("Could not read actual image")

        for i, sr in enumerate(sub_results):
            loc = sr.get("match_location")
            if not loc:
                continue
            x, y = loc["x"], loc["y"]
            w, h = loc["width"], loc["height"]
            color = (0, 255, 0) if sr["status"] == "pass" else (0, 0, 255)
            cv2.rectangle(img, (x, y), (x + w, y + h), color, 3)
            label = sr.get("label") or f"#{i + 1}"
            cv2.putText(img, f"{label} {sr['score']:.2f}", (x, y - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(output_path, img)
        return output_path

    # ------------------------------------------------------------------
    # High-level judge
    # ------------------------------------------------------------------

    def judge(
        self,
        expected_path: str,
        actual_path: str,
        threshold_pass: float = 0.95,
        threshold_warning: float = 0.85,
        roi: Optional[dict] = None,
        compare_mode: str = "full",
        exclude_rois: Optional[list[dict]] = None,
        crop_items: Optional[list[dict]] = None,
    ) -> dict:
        """Return pass/fail/warning judgement with mode-aware dispatch."""

        # --- Multi-crop mode ---
        if compare_mode == "multi_crop" and crop_items:
            mc_result = self.compare_multi_crop(
                actual_path, crop_items,
                threshold_pass=threshold_pass,
                threshold_warning=threshold_warning,
            )
            if "error" in mc_result:
                return {"status": "error", "score": 0.0, "message": mc_result["error"], "sub_results": []}

            sub_results = mc_result["sub_results"]
            # Overall: fail if any fail, warning if any warning, else pass
            statuses = [sr["status"] for sr in sub_results]
            if "fail" in statuses or "error" in statuses:
                status = "fail"
            elif "warning" in statuses:
                status = "warning"
            else:
                status = "pass"
            return {
                "status": status,
                "sub_results": sub_results,
            }

        # --- Full-exclude mode ---
        if compare_mode == "full_exclude" and exclude_rois:
            result = self.compare_ssim_with_exclusions(expected_path, actual_path, exclude_rois)
            if "error" in result:
                return {"status": "error", "score": 0.0, "message": result["error"]}
            score = result["score"]
            if score >= threshold_pass:
                status = "pass"
            elif score >= threshold_warning:
                status = "warning"
            else:
                status = "fail"
            return {"status": status, "score": score}

        # --- Full / Single-crop mode (existing behavior) ---
        result = self.compare_ssim(expected_path, actual_path, roi=roi)
        if "error" in result:
            return {"status": "error", "score": 0.0, "message": result["error"]}

        score = result["score"]
        if score >= threshold_pass:
            status = "pass"
        elif score >= threshold_warning:
            status = "warning"
        else:
            status = "fail"

        out: dict = {"status": status, "score": score}
        if "match_location" in result:
            out["match_location"] = result["match_location"]
        return out
