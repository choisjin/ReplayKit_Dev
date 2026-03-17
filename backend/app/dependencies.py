"""Shared service instances — 모든 라우터에서 동일 인스턴스 사용."""

from .services.adb_service import ADBService
from .services.device_manager import DeviceManager
from .services.image_compare_service import ImageCompareService
from .services.playback_service import PlaybackService
from .services.recording_service import RecordingService
from .services.scrcpy_service import ScrcpyManager

adb_service = ADBService()
device_manager = DeviceManager(adb_service)
image_compare_service = ImageCompareService()
recording_service = RecordingService(adb_service, device_manager)
playback_service = PlaybackService(adb_service, image_compare_service, device_manager)
scrcpy_manager = ScrcpyManager()
