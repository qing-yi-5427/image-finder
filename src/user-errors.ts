/** Remove transport wrappers; keep actionable domain errors readable in the UI. */
export function userError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/, "");
  const known: Record<string, string> = {
    SOURCE_DATA_OVERLAP: "原目录不能与图库数据目录重叠，请选择其他文件夹。",
    ROOT_OVERLAP: "所选目录与已关联的原目录重叠，请选择其他文件夹。",
    ROOT_NOT_FOUND: "目录索引已不存在，请刷新后重试。",
    NOT_DIRECTORY: "所选位置不是文件夹，请重新选择。",
    FILE_NOT_FOUND: "图片索引已不存在，请刷新后重试。",
    AI_MODEL_MISSING: "本地模型尚未就绪，请到设置的 AI 环境中安装模型与运行环境。",
    AI_ENVIRONMENT_BUSY: "AI 分析、语义搜索或安装正在运行，请等待完成或暂停待办后再清理。",
    AI_ENVIRONMENT_MAINTENANCE: "AI 环境正在清理，请稍后再试。",
    AI_WORKER_CLOSE_TIMEOUT: "AI 推理进程尚未完全退出，本次未清理环境，请稍后重试。",
    AI_HOME_NOT_WRITABLE: "模型目录当前不可写，请将便携程序放到可写目录，或设置 IMAGE_FINDER_AI_HOME 后重新启动。",
    AI_WORKER_EXITED: "本地推理进程已退出，可在后台任务重试失败图片。",
    AI_INFERENCE_TIMEOUT: "本次本地推理超时，可降低后台负载后重试。",
    DIRECTML_UNAVAILABLE: "DirectML 当前不可用，请在后台任务切换到 CPU。",
    AI_CANDIDATE_NOT_FOUND: "所选图片缺少该候选，请先识别图片，或仅审核包含该候选的图片。",
    AI_QUERY_EMPTY: "请输入画面描述后再进行语义搜索。",
  };
  if (known[message]) return known[message];
  if (/ENOENT|ENOTDIR/.test(message))
    return "文件或目录当前不可用，请检查磁盘连接和文件位置，并重新扫描原目录。";
  if (/EACCES|EPERM/.test(message))
    return "无法访问所选文件或目录，请检查访问权限或文件占用后重试。";
  if (message.includes("Original no longer matches"))
    return "原文件已变化，请重新扫描目录后再打开。";
  if (/Unsafe original|Original escapes|not a regular file/.test(message))
    return "图片路径无法安全读取，请检查原目录后重新扫描。";
  return message;
}
