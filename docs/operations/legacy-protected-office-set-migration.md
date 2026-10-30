# 本机办公集合升级

所有办公 Worker 与执行管理服务都在同一设备上。当前部署配置位于 `deploy/appliance`；本机 UUID 由 `PLATFORM_APPLIANCE_NODE_ID` 明确配置。

升级只替换已确认受影响的镜像与配置；页面更新不重启办公 Worker 或用户虚拟机。保留原容器、镜像、配置及精确回退目标。确认本地通信、健康与实际请求后再结束维护。

常驻集合的容量与 Android、Windows、投屏统一记账。不得仅为部署或验收释放空间而擅自停用用户承诺常驻的能力。高内存独占任务遵守已确认预算与显式准入。

旧部署的详细命令及结果保留在 [历史记录](../validation/protected-office-migration-before-single-appliance-20261016.md)，不得照搬为当前环境操作指令。

