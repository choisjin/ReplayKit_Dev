from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class StepType(str, Enum):
    TAP = "tap"
    LONG_PRESS = "long_press"
    SWIPE = "swipe"
    INPUT_TEXT = "input_text"
    KEY_EVENT = "key_event"
    WAIT = "wait"
    ADB_COMMAND = "adb_command"
    SERIAL_COMMAND = "serial_command"
    MODULE_COMMAND = "module_command"
    HKMC_TOUCH = "hkmc_touch"
    HKMC_SWIPE = "hkmc_swipe"
    HKMC_KEY = "hkmc_key"
    MULTI_TOUCH = "multi_touch"  # 멀티핑거 제스처 (핀치, 멀티스와이프)
    REPEAT_TAP = "repeat_tap"    # 같은 위치 연속 터치


class TapParams(BaseModel):
    x: int
    y: int


class SwipeParams(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int
    duration_ms: int = 300


class InputTextParams(BaseModel):
    text: str


class KeyEventParams(BaseModel):
    keycode: str  # e.g. "KEYCODE_HOME", "KEYCODE_BACK"


class WaitParams(BaseModel):
    duration_ms: int = 1000


class AdbCommandParams(BaseModel):
    command: str


class SerialCommandParams(BaseModel):
    data: str
    read_timeout: float = 1.0


class ROI(BaseModel):
    """Region of Interest for image comparison."""
    x: int
    y: int
    width: int
    height: int


class CompareMode(str, Enum):
    FULL = "full"                    # 전체화면 SSIM
    SINGLE_CROP = "single_crop"      # 단일 크롭 템플릿 매칭
    FULL_EXCLUDE = "full_exclude"    # 전체화면에서 영역 제외 SSIM
    MULTI_CROP = "multi_crop"        # 여러 크롭 각각 비교


class CropItem(BaseModel):
    """Multi-crop expected image entry."""
    image: str          # filename of the cropped expected image
    label: str = ""     # optional user label
    roi: Optional[ROI] = None  # crop region on the source screenshot


class Step(BaseModel):
    id: int
    type: StepType
    device_id: Optional[str] = None  # target device for this step
    screen_type: Optional[str] = None  # front_center|rear_left|rear_right|cluster (HKMC only)
    params: dict[str, Any]
    delay_after_ms: int = 1000
    expected_image: Optional[str] = None
    description: str = ""
    roi: Optional[ROI] = None  # optional region for verification
    similarity_threshold: float = 0.95
    on_pass_goto: Optional[int] = None  # step ID to jump to on pass (None = next)
    on_fail_goto: Optional[int] = None  # step ID to jump to on fail (None = next)
    compare_mode: CompareMode = CompareMode.FULL
    exclude_rois: list[ROI] = Field(default_factory=list)  # regions to exclude (full_exclude mode)
    expected_images: list[CropItem] = Field(default_factory=list)  # multi_crop mode
    screenshot_device_id: Optional[str] = None  # 이미지 비교용 디바이스 (wait 등 디바이스 비종속 스텝에서 사용)


class Scenario(BaseModel):
    name: str
    description: str = ""
    device_serial: Optional[str] = None
    resolution: Optional[dict[str, int]] = None  # {"width": 1080, "height": 1920}
    steps: list[Step] = Field(default_factory=list)
    device_map: dict[str, str] = Field(default_factory=dict)  # alias -> real device id (e.g. "Android_1" -> "RXCT30...")
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SubResult(BaseModel):
    """Per-crop comparison result for multi_crop mode."""
    label: str = ""
    expected_image: str = ""
    score: float = 0.0
    status: str = "pass"  # pass/warning/fail
    match_location: Optional[dict] = None


class StepResult(BaseModel):
    step_id: int
    repeat_index: int = 1  # which cycle (1-based)
    timestamp: Optional[str] = None  # ISO timestamp when step started
    device_id: str = ""  # which device executed this step
    command: str = ""  # human-readable action description
    description: str = ""  # user remark for the step
    status: str  # "pass", "fail", "error"
    similarity_score: Optional[float] = None
    expected_image: Optional[str] = None
    expected_annotated_image: Optional[str] = None  # expected with regions drawn
    actual_image: Optional[str] = None
    actual_annotated_image: Optional[str] = None  # actual with match box drawn
    diff_image: Optional[str] = None
    roi: Optional[ROI] = None  # ROI used for comparison (for frontend display)
    match_location: Optional[dict] = None  # {x, y, width, height} of matched region
    message: str = ""
    delay_ms: int = 0  # configured delay_after_ms
    execution_time_ms: int = 0  # actual duration
    compare_mode: Optional[str] = None
    sub_results: list[SubResult] = Field(default_factory=list)  # per-crop details for multi_crop


class ScenarioResult(BaseModel):
    scenario_name: str
    device_serial: str
    status: str  # "pass", "fail", "error"
    total_steps: int  # steps per cycle
    total_repeat: int = 1
    passed_steps: int = 0
    failed_steps: int = 0
    warning_steps: int = 0
    error_steps: int = 0
    step_results: list[StepResult] = Field(default_factory=list)  # ALL cycles combined
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
