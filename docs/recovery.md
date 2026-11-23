# 从源码准备本地环境

本仓库只交付源码和恢复说明，没有安装器或现成运行包。选择 `old/` 或 `new/` 后，必须先准备该目录的运行工具与依赖，才能使用 `saitu` 和 `.command` 启动入口。不要在仓库根目录执行 `./saitu`。

当前准备目标为macOS Apple Silicon：Node.js 24.22.1、pnpm 11.19.0、PostgreSQL 17.11。项目Node范围与pnpm要求另见各版 `package.json`。现有脚本使用macOS的zsh、`open` 和本地进程管理方式，不是Windows安装器或通用云服务器一键部署包。

## 1. 一次选择一个版本

从仓库根目录进入其中一版，例如：

```sh
cd new
```

`old/` 和 `new/` 各有自己的配置与数据目录，但都使用 `127.0.0.1:3190`（构建版）、`127.0.0.1:3191`（开发模式）、`127.0.0.1:5433`（PostgreSQL）。**一次只运行一个版本；切换前先在正在运行的版本执行 `./saitu stop`。** 脚本不会替你停止占用端口的其他项目。

## 2. 准备完整运行工具

在所选版本内准备以下结构；只放一个可执行文件通常不够，应保留对应发行包的支持文件与许可证：

```text
.runtime/
  node/bin/node
  pnpm/bin/pnpm.mjs
  postgres/bin/initdb
  postgres/bin/pg_ctl
  postgres/bin/postgres
  ...各工具其余必要文件...
```

可以自行准备兼容发行包，或从自己保留的兼容工具副本中**只复制这三个工具目录**。以下占位路径必须替换成你自己的工具位置，示例用于首次空 `.runtime`：

```sh
saitu_tools="/path/to/compatible-runtime"
mkdir -p .runtime
cp -R "$saitu_tools/node" .runtime/node
cp -R "$saitu_tools/pnpm" .runtime/pnpm
cp -R "$saitu_tools/postgres" .runtime/postgres
```

不要复制其他实例的 `.env.local`、`.local` 或数据库数据来“补齐环境”，也不要用指向其他版本/全局目录的外部软链接代替本副本工具和依赖。`verify` 会检查这些目录中的符号链接是否越出所选版本目录。

核对工具入口：

```sh
.runtime/node/bin/node --version
.runtime/node/bin/node .runtime/pnpm/bin/pnpm.mjs --version
.runtime/postgres/bin/postgres --version
```

## 3. 安装锁定依赖

首次先直接调用运行工具，**不要先运行 `./saitu pnpm install`**：控制脚本在加载时就依赖 `pg` 等项目包，裸clone尚未安装这些包。

```sh
export PATH="$PWD/.runtime/node/bin:$PATH"
.runtime/node/bin/node .runtime/pnpm/bin/pnpm.mjs install --frozen-lockfile
```

安装可能需要访问软件包注册表，与调用AI无关。安装完成后才可使用 `./saitu pnpm ...`；各版依赖和运行工具均需在各自目录准备。

## 4. 建立自己的本地配置

首次空配置时复制无凭据模板：

```sh
cp .env.example .env.local
chmod 600 .env.local
./saitu setup
```

已有本人的配置时不要用复制命令覆盖它。`setup` 会在本版本下生成随机数据库密码、会话签名秘密、本地实例标识及运行授权，执行数据库迁移，并把本地连接信息写入 `.env.local`；数据库只监听 `127.0.0.1:5433`，名称为 `saitu_clean`。应用角色不具有建库、改角色或自行提高预算的权限。

**这一步是使用者在本人机器上显式建立新的本地授权，不是沿用原作者的私人授权。** 初始化不会调用真实AI，也不附送服务商账号、余额或调用额度。重复执行不会自动清空现有数据库和账目；发现已有数据目录却缺凭据时会拒绝覆盖。

模板中的 `AI_API_KEY` 为空。离线构建和验证不需要真实服务密钥；需要真实AI时，由你在本机 `.env.local` 中填写自己的DeepSeek密钥。不要把该文件或生成的 `.local` 提交到Git。

旧模块的本地预算配置和新竞赛助手的授权分别管理。**`AI_SPEND_LIMIT_CNY=300` 不能当作新竞赛助手的金额上限：该助手授权代码不设金额上限。** 真实调用仍保留受限并发、180秒总期限、幂等任务及最多一次自动重试。主动提交真实AI任务会使用你配置的账号并产生费用，启动源码本身不构成对任何旧账号的授权。

## 5. 构建与启动

```sh
./saitu build
./saitu start --open
./saitu status
./saitu stop
```

构建会联合生成网页与后台worker，并检查绑定关系；修改源码后应停止并重建，或执行 `./saitu rebuild --open`。`start` 在缺少构建时也会尝试构建，因此它不能替代前面的工具、依赖与初始化步骤。

准备完成后，可使用各版自带的“启动赛途”“停止赛途”“查看状态”“开发模式”“重建并启动” `.command` 入口。开发模式使用3191端口；开发模式与构建版互斥，共用该副本数据。

```sh
./saitu dev --open
./saitu rebuild --open
```

关闭浏览器不会取消已派发后台任务；停止服务会先停止新任务派发并等待在途任务。后台继续运行需要本机服务和网络可用。停止后可以移动整个副本；运行时不要移动目录或删除 `.local`。

## 6. 离线验证与真实AI验证分开

准备工具、依赖和新本地数据库后运行：

```sh
./saitu verify
```

该命令检查目录独立性、权限、类型、lint、单元测试与真实的隔离PostgreSQL测试；使用临时数据库和受限角色，结束后清理。验证进程不携带真实AI密钥并阻止外部网络，不初始化或刷新当前实例的运行授权。结果写入你自己生成的 `.local/checks/core.json`，不代表真实AI输出质量或速度已通过。

真实模型验收只由带 `--live` 的显式脚本或主动提交的AI任务发起；本仓库上传、普通构建及离线验证不执行这些付费请求。可先看各版本README的验证说明和脚本 `--list`，再决定是否自行运行。公开记录见[验证目录](validation/README.md)；私人 `.local` 历史报告未随源码交付。

## 文件、数据与版本切换

| 路径 | 内容与处理 |
| --- | --- |
| `.runtime` | 使用者自行准备的本机工具，不进Git |
| `node_modules` | 按各版锁文件安装的依赖，不进Git |
| `.env.local`、`.local/private` | 本人的配置与凭据，不进Git、不公开分享 |
| `.local` | 新数据库、任务、账目、日志和验证记录，不进Git |
| `.next`、`.next-dev`、`dist` | 可重新生成的构建，不是公开仓库附带的运行包 |
| `artifacts`、`public` | 源码引用的必要证据及网站素材，保留其许可与原范围 |

两版数据库文件各自独立，不能因端口相同而认为数据可混用。浏览器收藏、草稿等按浏览器与来源地址保存；同一浏览器在同一端口切换版本时可能仍看到先前本地存储。需要隔离时使用独立浏览器配置，或通过页面提供的清除入口处理本人数据。仓库不自动导入、删除或恢复原作者的历史会话。

## 自行部署的准备边界

仓库含服务器管理源码，但本次交付不执行部署，不默认连接既有服务器，也不配置自动CI。部署者必须自行准备主机、域名、数据库、服务配置、恢复备份及管理员授权。

服务器客户端要求显式设置 `SAITU_SSH_HOST`（`user@hostname`）、`SAITU_SSH_HOST_FINGERPRINT`（自行核实的主机指纹）和绝对路径的 `SAITU_SSH_KEY_FILE`。保留 `StrictHostKeyChecking=yes`；不能跳过主机身份校验或复制别人的私钥/known_hosts当作自身配置。首次服务端初始化、密钥、生产授权和回滚由部署者按 `scripts/server/` 的代码在自己的环境准备。

`deploy`、`server-status`、`rollback` 不是本地恢复所必需的步骤。公共品牌网站地址只是品牌链接，不是这些命令的默认目标或对使用者的部署授权。
