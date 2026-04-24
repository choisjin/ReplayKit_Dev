import socket
import struct
import time
import random
import pandas as pd
from robot.api.deco import keyword
from robot.api import logger

# --- Constants for better readability ---
CANFD_INIT_PACKET_HEADER = [0x55, 0xAA, 0x64, 0x00, 0x04, 0x10]  # 100 in decimal is 0x64
CANFD_SEND_PACKET_HEADER = [0x55, 0xAA, 0x64, 0x00, 0x04, 0x30]
# CAN_FRAME_FLAGS_FDF_BRS_IDE = 0x8d  # FDF=1, BRS=1, IDE=1


# --- Helper function for payload size to DLC mapping ---
def get_dlc_from_payload_size(payload_size: int) -> int:
    """Maps CAN FD DLC values to actual payload sizes."""
    payload_size_to_dlc_map = {
        0: 0, 1: 1, 2: 2, 3: 3,
        4: 4, 5: 5, 6: 6, 7: 7,
        8: 8, 12: 9, 16: 10, 20: 11,
        24: 12, 32: 13, 48: 14, 64: 15
    }
    return payload_size_to_dlc_map.get(payload_size, 8)  # Default to 8 bytes if payload_size is unexpected


class SignalDefinition:
    """
    Represents the definition of a single CAN signal, including its
    conversion parameters.
    """

    def __init__(self, name, start_bit, length, byte_order, factor, offset):
        if not all(isinstance(arg, (str, int, float)) for arg in [name, start_bit, length, byte_order, factor, offset]):
            raise ValueError("All SignalDefinition parameters must be of valid types.")
        self.name = name
        self.start_bit = int(start_bit)
        self.length = int(length)
        self.byte_order = byte_order.strip().lower()  # Standardize byte order
        self.factor = float(factor)
        self.offset = float(offset)


class UDP_CANFD:
    """
    Provides keywords for initializing, deinitializing, and sending CAN FD
    signals over UDP, primarily for Robot Framework.
    Signal definitions are loaded from an Excel file.
    """

    def __init__(self):
        self.signal_defs = {}
        self.signal_map = {}  # Maps signal name to CAN ID and DLC
        self.udp_ip = '192.168.1.101'
        self.udp_port = 25000
        self.sock = None

    def UDP_INIT(self, file_path: str, udp_ip: str = '192.168.1.101', udp_port: int = 25000):
        self.udp_ip = udp_ip
        self.udp_port = udp_port
        try:
            if file_path.lower().endswith('.CAN'):
                self.load_signal_definitions_from_xml(file_path)
            else:
                self.load_signal_definitions_from_excel(file_path)

            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.connect((self.udp_ip, self.udp_port))
            self.UDP_CANFD_INIT_MESSAGE()
            logger.info(f"UDP socket initialized and CANFD configured for {self.udp_ip}:{self.udp_port}",
                        also_console=True)
        except Exception as e:
            logger.info(f"Failed to initialize UDP socket or load signals: {e}", also_console=True)
            self.UDP_DEINIT()
            raise

    @keyword('UDP DEINIT')
    def UDP_DEINIT(self):
        """Closes the UDP socket if it's open."""
        if self.sock:
            self.sock.close()
            self.sock = None
            logger.info("UDP socket closed", also_console=True)
        else:
            logger.info("UDP socket not active, no deinitialization needed.", also_console=True)

    def load_signal_definitions_from_excel(self, excel_file: str):
        """
        Loads signal definitions from the specified Excel file.
        Expects a specific header row (header=6).
        """
        try:

            if excel_file.lower().endswith('.xls'):
                df = pd.read_excel(excel_file, engine='xlrd', header=6)
            else:
                df = pd.read_excel(excel_file, engine='openpyxl', header=6)

            df.columns = [col.strip().replace('\n', ' ') for col in df.columns]

            required_columns = ['Signal Name', 'ID', 'Startbit', 'Length (Bit)', 'DLC']
            if not all(col in df.columns for col in required_columns):
                raise ValueError(f"Missing one or more required columns in Excel: {required_columns}")

            for index, row in df.iterrows():
                try:
                    # Skip rows where essential information is missing
                    if pd.isna(row['Signal Name']) or pd.isna(row['ID']) or \
                            pd.isna(row['Startbit']) or pd.isna(row['Length (Bit)']) or pd.isna(row['DLC']):
                        logger.info(f"Skipping row {index + 7} due to missing essential data.",
                                    also_console=True)  # +7 for 0-indexed and header rows
                        continue

                    signal_name = str(row['Signal Name']).strip()
                    # Handle both hex string and integer IDs
                    message_id = int(str(row['ID']).strip(), 16) if isinstance(row['ID'], str) and str(
                        row['ID']).strip().lower().startswith('0x') else int(row['ID'])
                    start_bit = int(row['Startbit'])
                    length = int(row['Length (Bit)'])
                    dlc = int(row['DLC'])

                    # Use .get() with default for optional columns to prevent KeyError
                    byte_order = str(row.get('Byte Order', 'Intel')).strip()
                    factor = float(row.get('Factor', 1.0))
                    offset = float(row.get('Offset', 0.0))

                    self.signal_defs[signal_name] = SignalDefinition(signal_name, start_bit, length, byte_order, factor,
                                                                     offset)
                    self.signal_map[signal_name] = {'id': message_id, 'dlc': dlc}

                except ValueError as ve:
                    logger.info(
                        f"Data conversion error in row {index + 7} for signal '{row.get('Signal Name', 'Unknown')}': {ve}",
                        also_console=True)
                except Exception as e:
                    logger.info(
                        f"Unexpected error parsing row {index + 7} for signal '{row.get('Signal Name', 'Unknown')}': {e}",
                        also_console=True)

            if not self.signal_defs:
                logger.info("No valid signal definitions were loaded from the Excel file.", also_console=True)

        except pd.errors.EmptyDataError:
            logger.info(f"Error: Excel file {excel_file} is empty or has no data.", also_console=True)
            raise
        except Exception as e:
            logger.info(f"Error loading signal definitions from Excel file {excel_file}: {e}", also_console=True)
            raise

    def load_signal_definitions_from_xml(self, xml_file: str):
        import xml.etree.ElementTree as ET

        try:
            tree = ET.parse(xml_file)
            root = tree.getroot()

            for signal in root.findall(".//SIGNAL"):
                try:
                    name = signal.findtext("SIGNALNAME", default="Unknown").strip()
                    can_id = signal.findtext("CODE", default="0").strip()
                    start_bit = int(signal.findtext("STARTBIT", default="0"))
                    length = int(signal.findtext("BITCOUNT", default="8"))
                    byte_order = signal.findtext("BYTEORDER", default="Intel").strip()
                    factor = float(signal.findtext("FACTOR", default="1.0"))
                    offset = float(signal.findtext("OFFSET", default="0.0"))
                    dlc = 8  # 기본값 또는 필요 시 계산

                    message_id = int(can_id)

                    self.signal_defs[name] = SignalDefinition(name, start_bit, length, byte_order, factor, offset)
                    self.signal_map[name] = {'id': message_id, 'dlc': dlc}
                except Exception as e:
                    logger.info(f"Error parsing SIGNAL entry: {e}", also_console=True)
        except Exception as e:
            logger.info(f"Error loading XML file: {e}", also_console=True)

    def UDP_CANFD_INIT_MESSAGE(self, baudrate: int = 0x1F4, databit_time: int = 0x7D0):
        """
        Sends the CAN FD initialization message over UDP.
        Args:
            baudrate (int): The CAN FD baudrate (default: 0x1F4 for 500k).
            databit_time (int): The CAN FD data bit rate (default: 0x7D0 for 2M).
        """
        if not self.sock:
            logger.info("UDP socket not initialized. Call UDP_INIT first.", also_console=True)
            return

        # Ensure values fit within 2 bytes
        if not (0 <= baudrate <= 0xFFFF and 0 <= databit_time <= 0xFFFF):
            logger.info("Baudrate or Data Bit Time out of valid range (0x0000-0xFFFF).", also_console=True)
            return

        packet_data = [
            (baudrate >> 8) & 0xFF, baudrate & 0xFF,
            (databit_time >> 8) & 0xFF, databit_time & 0xFF
        ]
        # Length bytes (total data length)
        total_data_length = len(packet_data)
        length_bytes = [(total_data_length >> 8) & 0xFF, total_data_length & 0xFF]

        packet = CANFD_INIT_PACKET_HEADER + length_bytes + [0, 0] + packet_data  # [0,0] seems to be filler or reserved
        try:
            self.sock.send(bytearray(packet))
            logger.info(f"Sent CANFD INIT packet: {[hex(b) for b in packet]}", also_console=True)
        except socket.error as e:
            logger.info(f"Error sending CANFD INIT packet: {e}", also_console=True)
            raise

    def UDP_CANFD_SEND(self, can_id: int, payload: bytearray):
        """
        Sends a raw CAN FD frame over UDP.
        Args:
            can_id (int): The CAN ID to send.
            payload (bytearray): The raw data payload of the CAN frame.
        """
        if not self.sock:
            logger.info("UDP socket not initialized. Call UDP_INIT first.", also_console=True)
            return

        # CAN ID in big endian (as per original code, assuming 4 bytes)
        can_id_bytes = [
            (can_id >> 24) & 0xFF,
            (can_id >> 16) & 0xFF,
            (can_id >> 8) & 0xFF,
            can_id & 0xFF
        ]

        # Combine CAN ID, frame info, and payload
        # Original code used [frame_info, 0], keeping 0 for now as 'reserved'
        frame_byte = 0
        frame_byte += 0b10000000  # FD set
        frame_byte += 0b00000000  # bitrate switch
        frame_byte += 0b00000000  # can extend
        frame_byte += get_dlc_from_payload_size(len(payload))
        data_to_send = bytearray(can_id_bytes + [frame_byte] + list(payload))

        # Total length of the data_to_send part for the packet header
        total_data_length = len(data_to_send)
        length_bytes = [(total_data_length >> 8) & 0xFF, total_data_length & 0xFF]

        packet = bytearray(CANFD_SEND_PACKET_HEADER + length_bytes) + data_to_send

        try:
            self.sock.send(packet)
            logger.info(
                f"Sent CANFD packet for ID {hex(can_id)} with payload {[hex(b) for b in payload]}: {[hex(b) for b in packet]}",
                also_console=True)
        except socket.error as e:
            logger.info(f"Error sending CANFD packet for ID {hex(can_id)}: {e}", also_console=True)
            raise

    @keyword('SEND CANFD SIGNAL')
    def SEND_CANEthernetData(self, signal_name: str, physical_value):
        """
        Sends a specific CAN FD signal with a given physical value.
        The physical value is converted to raw and then encoded into the CAN payload.
        Args:
            signal_name (str): The name of the signal as defined in the Excel file.
            physical_value (float or str): The physical value to send. Can be a float or a hex string (e.g., '0xFF').
        """
        if signal_name not in self.signal_defs:
            logger.info(f"Signal '{signal_name}' not found in definitions. Please check the Excel file.",
                        also_console=True)
            return False

        signal_def = self.signal_defs[signal_name]
        message_info = self.signal_map[signal_name]
        can_id = message_info['id']
        payload_size = message_info['dlc'] # excel file has payload size not DLC

        # Convert physical_value to numeric
        if isinstance(physical_value, str):
            try:
                if physical_value.lower().startswith("0x"):
                    physical_value = int(physical_value, 16)
                else:
                    physical_value = float(physical_value)
            except ValueError:
                logger.error(
                    f"Invalid physical value format for '{signal_name}': '{physical_value}'. Expected number or hex string (e.g., '0xAB').",
                    also_console=True)
                return False
        elif not isinstance(physical_value, (int, float)):
            logger.info(
                f"Unsupported physical value type for '{signal_name}': {type(physical_value)}. Expected int, float, or string.",
                also_console=True)
            return False

        # Calculate raw value
        try:
            # Prevent division by zero if factor is 0
            if signal_def.factor == 0:
                logger.info(f"Signal '{signal_name}' has a factor of 0, which prevents calculation of raw value.",
                            also_console=True)
                return False
            raw_value = int(round((physical_value - signal_def.offset) / signal_def.factor))
        except OverflowError:
            logger.info(
                f"Calculated raw value for '{signal_name}' ({physical_value}) is too large to fit in an integer.",
                also_console=True)
            return False
        except Exception as e:
            logger.info(f"Error calculating raw value for '{signal_name}' with physical value {physical_value}: {e}",
                        also_console=True)
            return False

        data = bytearray(payload_size)

        # Encode raw value into byte array
        for i in range(signal_def.length):
            bit_val = (raw_value >> i) & 1  # Get the i-th bit of raw_value
            if signal_def.byte_order == 'intel':  # Little endian
                # Intel (little endian) means least significant byte first,
                # and within byte, bits are from LSB to MSB (bit 0 to bit 7)
                bit_position_in_message = signal_def.start_bit + i
            else:  # Motorola (big endian)
                # Motorola (big endian) means most significant byte first,
                # and within byte, bits are from MSB to LSB (bit 7 to bit 0)
                # This logic assumes start_bit is the MSB of the signal.
                # If start_bit is LSB for Motorola, then adjust.
                bit_position_in_message = signal_def.start_bit + signal_def.length - 1 - i

            byte_index = bit_position_in_message // 8
            bit_index_in_byte = bit_position_in_message % 8

            if byte_index >= payload_size:
                logger.info(
                    f"Signal '{signal_name}' attempts to write beyond payload size (byte {byte_index} out of {payload_size}). Skipping.",
                    also_console=True)
                return False

            # Clear the bit at the target position and then set it
            data[byte_index] &= ~(1 << bit_index_in_byte)
            data[byte_index] |= (bit_val << bit_index_in_byte)

        # Send the CAN FD frame multiple times as per original logic
        for i in range(5):
            try:
                self.UDP_CANFD_SEND(can_id, data)
                time.sleep(0.2)  # ICU_02_200ms delay
            except Exception as e:
                logger.info(f"Failed to send CANFD frame for signal '{signal_name}' on attempt {i + 1}: {e}",
                            also_console=True)
                # Decide whether to continue or break on error
                break  # Break to prevent further attempts if one fails

        logger.info(f"Sent signal '{signal_name}' with physical value {physical_value} (raw: {raw_value})",
                    also_console=True)
        logger.info(f"Payload bytes for '{signal_name}': {[f'0x{b:02x}' for b in data]}", also_console=True)
        return True

    @keyword('CHECK CAN SIGNAL')
    def CHECK_CAN_SIGNAL(self):
        """
        Logs all loaded CAN signal definitions and their associated message info.
        """
        if not self.signal_defs:
            logger.info("No CAN signal definitions loaded.", also_console=True)
            return

        logger.info("--- Loaded CAN Signal Definitions ---", also_console=True)
        for signal_name, signal_def in self.signal_defs.items():
            message_info = self.signal_map.get(signal_name, {})
            can_id = message_info.get('id', 'N/A')
            dlc = message_info.get('dlc', 'N/A')
            logger.info(
                f"Signal: {signal_name}\n"
                f"  CAN ID: {f'0x{can_id:X}' if isinstance(can_id, int) else can_id}, DLC: {dlc}\n"
                f"  Start Bit: {signal_def.start_bit}, Length: {signal_def.length}\n"
                f"  Byte Order: {signal_def.byte_order}, Factor: {signal_def.factor}, Offset: {signal_def.offset}",
                also_console=True
            )
        logger.info("--- End of CAN Signal Definitions ---", also_console=True)

    @keyword("DOOR TEST")
    def door_test(self):
        """
        Performs a simple door test by sending 'Warn_DrvDrSwSta' signal.
        """
        logger.info("Starting Door Test...", also_console=True)
        # Check if the signal exists before attempting to send
        if 'Warn_DrvDrSwSta' not in self.signal_defs:
            logger.info("Signal 'Warn_DrvDrSwSta' not defined in the Excel file. Cannot perform Door Test.",
                        also_console=True)
            return False

        # Use the SEND_CANEthernetData keyword which handles error logging internally
        self.SEND_CANEthernetData('Warn_DrvDrSwSta', 0x0)
        time.sleep(1)
        self.SEND_CANEthernetData('Warn_DrvDrSwSta', 0x1)
        time.sleep(1)
        self.SEND_CANEthernetData('Warn_DrvDrSwSta', 0x0)
        time.sleep(1)
        self.SEND_CANEthernetData('Warn_DrvDrSwSta', 0x1)
        logger.info("Door Test completed.", also_console=True)
        return True

    @keyword("TEST ALL CANFD SIGNALS")
    def test_all_canfd_signals(self):
        """
        테스트 가능한 모든 CAN FD 신호를 순차적으로 전송합니다.
        각 신호에 대해 물리값 범위 내에서 테스트 값을 생성하여 전송합니다.
        """
        if not self.signal_defs:
            logger.info("신호 정의가 로드되지 않았습니다. 먼저 UDP_INIT를 호출하세요.", also_console=True)
            return False

        logger.info("--- 모든 CANFD 신호 테스트 시작 ---", also_console=True)

        for signal_name, signal_def in self.signal_defs.items():
            try:
                # 최대 raw 값 계산
                max_raw = (1 << signal_def.length) - 1
                if max_raw < 0:
                    max_raw = 0

                # 테스트용 raw 값 선택 (중간값)
                test_raw = max_raw // 2

                # 물리값 계산
                physical_value = signal_def.offset + signal_def.factor * test_raw

                # 신호 전송
                success = self.SEND_CANEthernetData(signal_name, physical_value)
                if success:
                    logger.info(f"[TEST] '{signal_name}' 전송 성공 - 물리값: {physical_value}, Raw: {test_raw}",
                                also_console=True)
                else:
                    logger.info(f"[TEST] '{signal_name}' 전송 실패", also_console=True)

                time.sleep(0.1)  # 네트워크 부하 방지용 딜레이

            except Exception as e:
                logger.info(f"[ERROR] '{signal_name}' 테스트 중 오류 발생: {e}", also_console=True)

        logger.info("--- 모든 CANFD 신호 테스트 완료 ---", also_console=True)
        return True


if __name__ == "__main__":

    EXCEL_FILE_PATH = "C:\\workspace\\hyundai_project\\ccic_robot\\resource\\20231210_STD_DB_CAR_2021_HS_M_v23.11.03W_v2.xls"

    TEST_UDP_IP = '192.168.1.101'
    TEST_UDP_PORT = 25000

    can_fd_client = None  # 클라이언트 객체 초기화

    try:
        print(f"--- UDP_CANFD 테스트 시작 (Excel: {EXCEL_FILE_PATH}, IP: {TEST_UDP_IP}, Port: {TEST_UDP_PORT}) ---")

        # 1. UDP 초기화
        print("\n--- 1. UDP 초기화 및 신호 정의 로드 ---")
        can_fd_client = UDP_CANFD()
        can_fd_client.UDP_INIT(EXCEL_FILE_PATH, TEST_UDP_IP, TEST_UDP_PORT)
        print("UDP 초기화 완료.")
        time.sleep(1)  # 초기화 후 잠시 대기

        # 2. 로드된 신호 정의 확인
        print("\n--- 2. 로드된 CAN 신호 정의 확인 ---")
        # can_fd_client.CHECK_CAN_SIGNAL_DEFINITIONS()
        time.sleep(1)

        # 3. 특정 신호 보내기 테스트
        print("\n--- 3. 'Warn_DrvDrSwSta' 신호 테스트 (물리값 0과 1) ---")
        # 이 신호가 Excel 파일에 정의되어 있어야 합니다.
        if can_fd_client.SEND_CANEthernetData('Warn_DrvDrSwSta', 0x0):
            print("Warn_DrvDrSwSta: 0x0 전송 성공.")
        else:
            print("Warn_DrvDrSwSta: 0x0 전송 실패 또는 신호 없음.")
        time.sleep(1)

        if can_fd_client.SEND_CANEthernetData('Warn_DrvDrSwSta', 0x1):
            print("Warn_DrvDrSwSta: 0x1 전송 성공.")
        else:
            print("Warn_DrvDrSwSta: 0x1 전송 실패 또는 신호 없음.")
        time.sleep(1)

        # 5. DOOR TEST 키워드 실행
        print("\n--- 5. DOOR TEST 키워드 실행 ---")
        can_fd_client.door_test()
        print("DOOR TEST 완료.")
        time.sleep(2)

        # 6. 랜덤 CAN 신호 보내기 테스트
        print("\n--- 6. 랜덤 CAN 신호 보내기 테스트 (모든 정의된 신호에 대해) ---")
        # can_fd_client.SEND_RANDOM_CAN_SIGNALS()
        print("랜덤 CAN 신호 전송 완료.")
        time.sleep(2)

    except FileNotFoundError as e:
        print(f"오류: Excel 파일을 찾을 수 없습니다: {e}", flush=True)
    except Exception as e:
        print(f"테스트 중 예외 발생: {e}", flush=True)
    finally:
        # 7. UDP 연결 해제
        print("\n--- 7. UDP 연결 해제 ---")
        if can_fd_client:
            can_fd_client.UDP_DEINIT()
        print("UDP 연결 해제 완료.")
        print("\n--- UDP_CANFD 테스트 종료 ---")
