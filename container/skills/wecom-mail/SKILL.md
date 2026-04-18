---
name: wecom-mail
description: 发送企业微信邮箱 / 腾讯企业邮箱 / Exmail 邮件。用户需要起草、预览或发送企微邮件时使用；通过 skill 自带的 Python 脚本读取 JSON 配置并发信。
---

# 企微邮件发送 Skill

当用户要求发送企业微信邮箱、腾讯企业邮箱或 Exmail 邮件时，使用这个 skill。

## 安全规则

- 先帮用户起草，不要直接发出，需要用户二次确认明确`发送`时再发送。
- 发信前确认收件人、主题、正文、抄送、密送、附件是否正确。
- 信息不完整时先补齐，不要自行猜测收件人或附件。
- 默认用纯文本正文；只有用户明确要求时才发送 HTML。

## 目录结构

- `scripts/send_wecom_mail.py`：实际发信脚本
- `references/config.json`：JSON 配置文件，脚本固定读取这里

## 配置文件

脚本直接读取 skill 内的固定配置文件：

`/home/node/.claude/skills/wecom-mail/references/config.json`

其中：
- `defaults.cc`：默认抄送地址列表
- `defaults.bcc`：默认密送地址列表
- 命令行传入的 `--cc`、`--bcc` 会追加到默认列表后面一起发送
- 脚本不再从工作区搜索配置，也不接受自定义配置文件路径

## 脚本说明

先预览，不发送：

```bash
python3 /home/node/.claude/skills/wecom-mail/scripts/send_wecom_mail.py \
  --to "alice@example.com" \
  --cc "bob@example.com" \
  --subject "项目进展同步" \
  --body "今天已完成接口联调，测试环境已更新。" \
  --dry-run
```

确认后实际发送：

```bash
python3 /home/node/.claude/skills/wecom-mail/scripts/send_wecom_mail.py \
  --to "alice@example.com" \
  --cc "bob@example.com" \
  --subject "项目进展同步" \
  --body "今天已完成接口联调，测试环境已更新。"
```

正文较长时，先写到临时文件：

```bash
tmp=$(mktemp)
cat > "$tmp" <<'EOF'
各位好，

本周上线窗口已确认，变更内容如下：
1. 修复登录超时问题
2. 优化账单导出性能

如无异议，今晚 20:00 开始发布。
EOF

python3 /home/node/.claude/skills/wecom-mail/scripts/send_wecom_mail.py \
  --to "team@example.com" \
  --subject "今晚发布通知" \
  --body-file "$tmp"
```

带附件：

```bash
python3 /home/node/.claude/skills/wecom-mail/scripts/send_wecom_mail.py \
  --to "team@example.com" \
  --subject "周报" \
  --body "附件是本周周报，请查收。" \
  --attach "/workspace/group/reports/weekly.pdf"
```

发送 HTML：

```bash
python3 /home/node/.claude/skills/wecom-mail/scripts/send_wecom_mail.py \
  --to "team@example.com" \
  --subject "版本发布公告" \
  --html-file "/workspace/group/release.html"
```

## 参数说明

- `--to` 必填，可传多个，也可传逗号分隔的多个地址
- `--cc` 可选
- `--bcc` 可选
- `--subject` 必填
- `--body` 纯文本正文
- `--body-file` 从文件读取纯文本正文
- `--html-file` 从文件读取 HTML 正文
- `--attach` 可重复传入多个附件
- `--from-name` 覆盖配置中的发件人名称
- `--reply-to` 指定回复地址
- `--dry-run` 仅打印解析后的发信摘要，不真正发送

## 工作流程

1. 如果用户只是让你“写一封邮件”，先整理出标题、收件人、正文草稿。
2. 如果用户明确要求“发送”，先用 `--dry-run` 做一次摘要检查。
3. 先把收件人、发件人、主题、内容、抄送人、附件等信息发送给用户确认，用户明确可以发送后再执行真实发送。
4. 发送成功后，向用户回报收件人、主题、抄送、附件数量。

## 常见问题

### 找不到配置文件

先检查：

```bash
ls -l /home/node/.claude/skills/wecom-mail/references/config.json
```

### 认证失败

- 确认 `smtp.user` 和 `smtp.pass` 正确
- 确认邮箱已开启 SMTP 服务
- 确认端口和加密方式与企业邮箱后台一致

### 发送失败

- 检查收件人地址格式
- 检查附件文件是否存在
- 若报 TLS 或端口错误，检查 `smtp.port` 和 `smtp.secure`
