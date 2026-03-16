# -*- coding: utf-8 -*- 
from datetime import datetime
import time
import os
import sys
import subprocess
sys.path.append(os.getcwd()+'\\Resources')
'''
    Path
'''
CCIC_AGENT = None
WOOHYUN_BENCH = None
QE_BENCH = None
smart_bench = None
ETHCC_DB = None
# DEFAULT_IMAGE_PATH = os.getcwd()+'\\Resources\\'
# DEFAULT_IMAGE_PATH = os.getcwd()+'\\..\\Resources\\'
current_dir = os.path.dirname(os.path.abspath(__file__))
# print(current_dir)
DEFAULT_IMAGE_PATH = current_dir+'\\..\\Resources\\'

DEFAULT_IMAGE_NAME = str(datetime.now().strftime('%Y%m%d_%H%M%S'))
CURRENT_RESULT_PATH = "D:\\excelrunner_report\\captured_image\\"

'''
    BENCH
'''
BENCH_IP = '192.168.1.101'
BENCH_PORT = 25000
BENCH_TOOL_IP = '127.0.0.1'
BENCH_TOOL_PORT = 5020
BENCH_TOOL_CAPTION = ""
BENCH_TOOL_HANDLE = 0
BENCH_TOOL_CONNECT_SIM_BUTTON_HANDLE = 0
BENCH_TOOL_DISCONNECT_SIM_BUTTON_HANDLE = 0
BENCH_TOOL_ETHCC_BUTTON_HANDLE = 0

'''
    SSH
'''
SSH_ID = 'root'
SSH_PW = 'root'
SSH_IP = '192.168.105.100'

'''
    press type
'''
LONG_PRESS = 1
SHORT_PRESS = 0

'''
    monitor
'''
FRONT = 0
REAR_R = 1
REAR_L = 2
CLUSTER = 3
HUD = 4

'''
    gear
'''
P = 0
R = 7
N = 6
D = 5

'''
    etc
'''
ON = 1
OFF = 0

OPEN = 1
CLOSE = 0

'''
    radio band
'''
FM = 0
AM = 1
SXM = 2

'''
    CUSTOM KEY LIST
'''
HOME = 0
DMB = 1
DISPLAY_OFF = 2
PHONE = 3
PHONE_PROJECTION = 4


'''
    THEME
'''
WHITE = 0
BLACK = 1


'''
    Variant
'''
KOR = 1
NAM = 2
EUR = 3
ME = 4
 

GET_LOG_TIME = None
VARIABLE_TIMER = 0
VARIABLE_INDEX = 0
BOOTING_TIMER = 45
FIRST_CYCLE = True
TEST_CYCLE = 1
CYCLE_RESULT = []
REPORT_ROW = 1
REPORT_COLUMN = 1
CURRENT_SPLIT_SCREEN = 0
TEST_START_TIME = time.time()
HK_COUNT = 0
SK_COUNT = 0
DRAG_COUNT = 0
ETHERNET_COUNT = 0
STRESS_FLAG = True
FORMAT_WRITE = False
DOOR_LOGIC_OFF_DELAY = 120
TIMEOUT_SLEEP_DELAY = 190 + 80  #ADM -> logic off(190), logic off -> sleep(70)
SLEEP_DELAY = 360 
NOW_SELECTOR_PORT = 1
TCP_FLAG = False
SEQUENCE_BOOT_DELAY = 0
SEQUENCE_ACC_DELAY = 1
SEQUENCE_IGN_DELAY = 0
BOOT_DELAY = 1
INCREASE_DELAY = 1

BACKGROUND_UPDATE_TIME = 600

UI_APP = ["appdmb",
        "appradio",
        "bluetooth",
        "camera",
        "ccshmi",
        "climatehmi",
        "evhmi",
        "homehmi",
        #"mediaplayerhmi",
        "naturesoundhmi",
        "NaviHmiApp",
        "quietmodehmi",
        "settinghmi",
        "userprofile",
        "voice-recognition",
        "voicememohmi",
        "webmanualhmi",
        "NaviEngineApp"
        "TimeManager"
        ]