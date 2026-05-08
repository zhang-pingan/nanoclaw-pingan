---
name: wecom-docs
description: 操作企微/腾讯文档。用户需要查询、搜索、读取元信息、查看协作者、检查未读通知、按腾讯文档 Open API 或 SaaS API 调用文档接口时使用；鉴权、token 与接口地址从 skill 自带 JSON 配置读取。
---

# 企微/腾讯文档操作 Skill

当用户要求操作企微文档、腾讯文档、企业文档、需求文档或协作文档时使用这个 skill。

## 安全规则

- 读取、搜索、列出、查看元信息可以直接执行。
- 创建、移动、删除、改权限、分享、评论、写入文档等写操作，必须先向用户说明操作对象和影响，等用户明确确认后再执行。
- 不要在回复中输出 `client_secret`、`access_token`、`refresh_token` 等鉴权信息。
- 默认只读取必要的文档元信息和摘要；需要读取完整正文或导出文档时，先确认范围。
- 如果接口返回权限不足，不要绕过权限；向用户说明需要补充授权或让文档所有者授权。

## 目录结构

- `scripts/wecom_docs.py`：实际 API 调用脚本。
- `references/config.json`：鉴权、token、接口地址和默认查询配置。脚本固定读取这里。

## 配置文件

脚本固定读取：

`/home/node/.claude/skills/wecom-docs/references/config.json`

配置中应放：

- `provider`：`tencent-docs-openapi` 或 `tencent-docs-saas`。
- `base_url`：API 基础地址，默认 `https://docs.qq.com`。
- `auth.client_id`、`auth.client_secret`、`auth.open_id`。
- `auth.access_token` 或 `auth.token_file` 指向的 token 缓存。
- `auth.oauth.authorize_url`、`auth.oauth.token_url`、`auth.oauth.scope`。
- `endpoints`：接口路径映射，可按官方 API 变化覆盖。

## 常用命令

检查配置是否齐全，不输出密钥：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py config-check
```

生成 OAuth 授权 URL：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py oauth-url \
  --state nanoclaw-docs
```

用授权码换 token，并写入 `auth.token_file`：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py exchange-code \
  --code "AUTH_CODE_FROM_CALLBACK"
```

刷新 token：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py refresh-token
```

关键字搜索：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py search \
  --keyword "需求 会员权益"
```

按过滤接口列出文档：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py filter \
  --payload '{"sortType":"modify","pageSize":20}'
```

查看文档元信息：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py metadata \
  --file-id "FILE_ID"
```

查看协作者：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py collaborators \
  --file-id "FILE_ID"
```

查询未读通知数：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py unread-count
```

调用任意配置外接口：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py request \
  --method GET \
  --path "/openapi/drive/v2/files/FILE_ID/metadata"
```

POST JSON：

```bash
python3 /home/node/.claude/skills/wecom-docs/scripts/wecom_docs.py request \
  --method POST \
  --path "/openapi/drive/v2/search" \
  --json '{"keyword":"验收标准","pageSize":10}'
```

## 工作流程

1. 先明确用户目标：搜索文档、读取元信息、查协作者、查未读、还是做写操作。
2. 运行 `config-check`；缺少配置时告诉用户具体缺哪一项。
3. 若缺 token，先生成 `oauth-url`，让用户完成授权，再用 `exchange-code` 换 token。
4. 对搜索和列表结果，先返回标题、owner、更新时间、URL、相关原因。
5. 如果用户要把文档作为需求处理，先输出摘要和待确认问题，再交给工作台或今日计划流程。
6. 写操作只在用户确认后执行，并回报接口返回的文档 ID、URL 或错误原因。

## 故障处理

- `401/403`：token 失效、open_id 不匹配或应用无权限。先运行 `refresh-token`，仍失败则重新 OAuth 授权。
- `404`：确认 `file_id` 是否正确，或当前账号是否有文档权限。
- `429`：接口限流，稍后重试，不要循环请求。
- 返回结构和预期不一致：使用 `request` 直接调用官方路径，并检查 `references/config.json` 中 `endpoints` 是否需要更新。
