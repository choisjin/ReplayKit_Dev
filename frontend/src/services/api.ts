import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

// Device APIs
export const deviceApi = {
  list: () => api.get('/device/list'),
  getInfo: (deviceId: string) => api.get(`/device/info/${deviceId}`),
  screenshot: (deviceId: string) => api.get(`/device/screenshot/${deviceId}`, { params: { fmt: 'jpeg' } }),
  scan: () => api.get('/device/scan'),
  connect: (type: string, address: string, baudrate?: number, name?: string, category?: string, module?: string, connect_type?: string, extra_fields?: Record<string, any>, device_id?: string) =>
    api.post('/device/connect', { type, address, baudrate, name, category, module, connect_type, extra_fields, device_id }),
  disconnect: (deviceId: string) => api.post('/device/disconnect', { address: deviceId }),
  updateDevice: (device_id: string, updates: Record<string, any>) =>
    api.post('/device/update', { device_id, ...updates }),
  adbRestart: () => api.post('/device/adb-restart'),
  input: (deviceId: string, action: string, params: Record<string, any>) =>
    api.post('/device/input', { device_id: deviceId, action, params }),
  listModules: () => api.get('/device/modules'),
  getModuleFunctions: (moduleName: string) => api.get(`/device/modules/${moduleName}/functions`),
};

// Scenario APIs
export const scenarioApi = {
  list: () => api.get('/scenario/list'),
  get: (name: string) => api.get(`/scenario/${name}`),
  delete: (name: string) => api.delete(`/scenario/${name}`),
  update: (name: string, data: any) => api.put(`/scenario/${name}`, data),
  rename: (name: string, newName: string) => api.post(`/scenario/${name}/rename`, { new_name: newName }),
  startRecording: (name: string, description?: string) =>
    api.post('/scenario/record/start', { name, description }),
  resumeRecording: (name: string) =>
    api.post('/scenario/record/resume', { name }),
  addStep: (step: any) => api.post('/scenario/record/step', step),
  deleteStep: (stepIndex: number) => api.post('/scenario/record/delete-step', { step_index: stepIndex }),
  stopRecording: () => api.post('/scenario/record/stop'),
  recordingStatus: () => api.get('/scenario/record/status'),
  play: (name: string, verify = true) =>
    api.post(`/scenario/${name}/play`, { verify }),
  stopPlayback: () => api.post('/scenario/playback/stop'),
  playbackStatus: () => api.get('/scenario/playback/status'),
  saveExpectedImage: (scenarioName: string, stepIndex: number, imageBase64: string, crop?: { x: number; y: number; width: number; height: number }, compareMode?: string, cropLabel?: string) =>
    api.post('/scenario/record/save-expected-image', { scenario_name: scenarioName, step_index: stepIndex, image_base64: imageBase64, crop, compare_mode: compareMode, crop_label: cropLabel }),
  captureExpectedImage: (scenarioName: string, stepIndex: number, deviceId: string, crop?: { x: number; y: number; width: number; height: number }, compareMode?: string, cropLabel?: string) =>
    api.post('/scenario/record/capture-expected-image', { scenario_name: scenarioName, step_index: stepIndex, device_id: deviceId, crop, compare_mode: compareMode, crop_label: cropLabel }),
  removeCrop: (scenarioName: string, stepIndex: number, cropIndex: number) =>
    api.post('/scenario/record/remove-crop', { scenario_name: scenarioName, step_index: stepIndex, crop_index: cropIndex }),
  cropFromExpected: (scenarioName: string, stepIndex: number, crop: { x: number; y: number; width: number; height: number }, cropLabel?: string, replaceIndex?: number) =>
    api.post('/scenario/record/crop-from-expected', { scenario_name: scenarioName, step_index: stepIndex, crop, crop_label: cropLabel || '', replace_index: replaceIndex }),
  testStep: (scenarioName: string, stepIndex: number, stepData?: any) =>
    api.post('/scenario/test-step', { scenario_name: scenarioName, step_index: stepIndex, step_data: stepData }),
  // Groups
  getGroups: () => api.get('/scenario/groups'),
  createGroup: (name: string) => api.post('/scenario/groups', { name }),
  renameGroup: (oldName: string, newName: string) => api.put('/scenario/groups', { old_name: oldName, new_name: newName }),
  deleteGroup: (groupName: string) => api.delete(`/scenario/groups/${groupName}`),
  addToGroup: (groupName: string, scenarioName: string) =>
    api.post(`/scenario/groups/${groupName}/add`, { scenario_name: scenarioName }),
  removeFromGroup: (groupName: string, scenarioName: string) =>
    api.post(`/scenario/groups/${groupName}/remove`, { scenario_name: scenarioName }),
  reorderGroup: (groupName: string, ordered: string[]) =>
    api.post(`/scenario/groups/${groupName}/reorder`, { ordered }),
  updateGroupJumps: (groupName: string, index: number, on_pass_goto: { scenario: number; step: number } | null, on_fail_goto: { scenario: number; step: number } | null) =>
    api.post(`/scenario/groups/${groupName}/jumps`, { index, on_pass_goto, on_fail_goto }),
  updateGroupStepJumps: (groupName: string, index: number, stepId: number, on_pass_goto: { scenario: number; step: number } | null, on_fail_goto: { scenario: number; step: number } | null) =>
    api.post(`/scenario/groups/${groupName}/step-jumps`, { index, step_id: stepId, on_pass_goto, on_fail_goto }),
  // Copy & Merge
  copy: (name: string, targetName: string) =>
    api.post(`/scenario/copy/${name}`, { target_name: targetName }),
  merge: (names: string[], targetName: string) =>
    api.post('/scenario/merge', { names, target_name: targetName }),
  // Export / Import
  exportZip: (scenarios: string[], groups: string[], includeAll: boolean = false) =>
    api.post('/scenario/export', { scenarios, groups, include_all: includeAll }, { responseType: 'blob' }),
  importPreview: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/scenario/import/preview', form);
  },
  importApply: (file: File, resolutions: object) => {
    const form = new FormData();
    form.append('file', file);
    form.append('resolutions', JSON.stringify(resolutions));
    return api.post('/scenario/import/apply', form);
  },
};

// Results APIs
export const resultsApi = {
  list: () => api.get('/results/list'),
  get: (filename: string) => api.get(`/results/${filename}`),
  delete: (filename: string) => api.delete(`/results/${filename}`),
  exportExcel: (filename: string) =>
    api.get(`/results/export/${filename}`, { responseType: 'blob' }),
};

export default api;
