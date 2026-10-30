# 本机虚拟设备存储维护

这些 Python 工具只供安装程序或管理员在本机维护时调用，不是成员接口，也不接收网页传入的路径。正常安装优先使用已挂载的本机加密数据目录。只有明确选择文件池时，才使用这里的文件池工具；不要给已有客户机重新执行 `prepare`。

## 本机计划

`phone_file_pool.py` 和 `phone_pool_growth.py` 使用 root 所有、不可被普通用户修改的 JSON 文件。新版格式为 `schemaVersion: 2`，没有远程主机、SSH 或另一台机器保管密钥的选项。

```json
{
  "schemaVersion": 2,
  "poolId": "11111111-1111-4111-8111-111111111111",
  "capacityBytes": 103079215104,
  "phoneQuotaBytes": 25769803776,
  "authorization": {
    "filePoolCreationApproved": true,
    "physicalDiskEraseApproved": false,
    "repartitionApproved": false,
    "nodeRebootApproved": false
  },
  "appliance": {
    "hostname": "local-appliance",
    "rootFilesystemUUID": "22222222-2222-4222-8222-222222222222"
  },
  "keyStore": {
    "encryptedRoot": "/srv/appliance-data",
    "filesystemUUID": "33333333-3333-4333-8333-333333333333",
    "mapper": "appliance-data"
  }
}
```

数值只是格式示例，不是推荐容量或产品上限。安装时生成独立 `poolId`，并从本机读取真实 hostname、根文件系统 UUID、密钥所在文件系统 UUID 和 LUKS 映射名。容量按用户配置和实际空间填写，必须按 4096 字节对齐；每部手机的配额小于池容量。示例 UUID 不能用于真实设备。

`keyStore.encryptedRoot` 必须已经在**同一台盒子**上解锁挂载，且不能位于将由此密钥解锁的池内。工具检查挂载源、文件系统 UUID 和 LUKS2 类型后，才读取其下 `phone-pool-keys/<poolId>/unlock.key`。密钥不经过 SSH、标准输入或标准输出；检查命令只返回元数据。

本机只读检查的调用形式：

```sh
sudo python3 deploy/android/cuttlefish/phone_file_pool.py --plan /path/to/local-pool.json key-inspect
sudo python3 deploy/android/cuttlefish/phone_file_pool.py --plan /path/to/local-pool.json inspect
```

新建时才允许按顺序执行 `key-create` 和 `prepare`；已有密钥或文件池会被拒绝覆盖。`open` 只打开身份匹配的已有池，`header-save` 将新头部备份保存在同机加密密钥目录，均不格式化物理盘。扩容由 `phone_pool_growth.py` 使用同一计划和同机密钥执行，不能通过改 JSON 假称实际池已扩容。

## Windows 实验文件池

`deploy/windows-arm64/lab_storage.py --plan /path/to/local-windows-pool.json inspect` 使用同一格式，另加 `labId`，例如 `windows-arm64-storage-20261016-a1`。`poolId` 仍须独立生成。该工具只处理这一个明确的实验文件，不搜索或替换已有 Windows 数据；没有远端密钥导出模式。正常产品 Windows 磁盘继续使用安装时配置的持久数据目录。

## 重启恢复

`phone_boot_resume.py` 的恢复计划使用 `version: 2`、`applianceHostname` 和本机 `poolPlan`。安装程序必须从现有服务读取真实的 Agent 容器 ID、镜像、挂载、服务名、已安装文件哈希及池 UUID，并绑定到同一个 `poolId`，不能把测试示例作为恢复清单。计划不包含远程角色或 SSH 地址。

恢复先确认本机身份及已安装配置，再打开原池并启动原控制服务；不会重建容器、启动手机、生成新密钥、格式化磁盘或反转管理员本次开机后的手动停止。加密密钥目录应先解锁挂载；不可用时返回明确错误，不能绕过到其他机器取密钥。

旧双机格式会明确拒绝。升级必须保留现有池、密钥和客户机身份，核实密钥已存在本机加密目录后生成新的本机计划；这不是重新创建池的理由。代码更新本身不执行迁移、磁盘操作或设备重启。
