#!/usr/bin/env python3
import argparse
import json
import mimetypes
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Iterable, Optional


SKILL_CONFIG_PATH = Path("/home/node/.claude/skills/wecom-mail/references/config.json")


def fail(message: str) -> None:
    print(f"send_wecom_mail.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def split_addresses(values: Optional[Iterable[str]]) -> list[str]:
    result: list[str] = []
    for value in values or []:
        for part in value.split(","):
            addr = part.strip()
            if addr:
                result.append(addr)
    return result


def load_config(config_path: Optional[Path]) -> tuple[dict, Path]:
    candidate = config_path or SKILL_CONFIG_PATH
    if candidate.is_file():
        with candidate.open("r", encoding="utf-8") as f:
            return json.load(f), candidate

    fail(f"config not found: {candidate}")


def read_text_arg(text: Optional[str], file_path: Optional[str], kind: str) -> Optional[str]:
    if text and file_path:
        fail(f"use only one of inline {kind} and {kind} file")
    if file_path:
        path = Path(file_path)
        if not path.is_file():
            fail(f"{kind} file not found: {path}")
        return path.read_text(encoding="utf-8")
    return text


def build_message(args: argparse.Namespace, config: dict) -> tuple[EmailMessage, list[str], str]:
    smtp = config.get("smtp") or {}
    from_cfg = config.get("from") or {}
    defaults = config.get("defaults") or {}

    smtp_host = smtp.get("host", "smtp.exmail.qq.com")
    smtp_port = int(smtp.get("port", 465))
    smtp_secure = bool(smtp.get("secure", True))
    smtp_user = smtp.get("user")
    smtp_pass = smtp.get("pass")
    from_address = from_cfg.get("address") or smtp_user
    from_name = args.from_name or from_cfg.get("name", "")
    reply_to = args.reply_to or config.get("reply_to")

    if not smtp_user:
        fail("config.smtp.user is required")
    if not smtp_pass:
        fail("config.smtp.pass is required")
    if not from_address:
        fail("config.from.address is required")

    to_addrs = split_addresses(args.to)
    cc_addrs = split_addresses(defaults.get("cc")) + split_addresses(args.cc)
    bcc_addrs = split_addresses(defaults.get("bcc")) + split_addresses(args.bcc)
    all_recipients = to_addrs + cc_addrs + bcc_addrs
    if not to_addrs:
        fail("at least one --to recipient is required")

    body_text = read_text_arg(args.body, args.body_file, "body")
    html_text = read_text_arg(None, args.html_file, "html")
    if body_text is not None and html_text is not None:
        fail("use only one of --body/--body-file or --html-file")

    msg = EmailMessage()
    msg["From"] = formataddr((from_name, from_address)) if from_name else from_address
    msg["To"] = ", ".join(to_addrs)
    if cc_addrs:
        msg["Cc"] = ", ".join(cc_addrs)
    if reply_to:
        msg["Reply-To"] = reply_to
    msg["Subject"] = args.subject

    if html_text is not None:
        msg.set_content("This message contains an HTML body.")
        msg.add_alternative(html_text, subtype="html")
        body_type = "text/html"
    else:
        msg.set_content(body_text or "", subtype="plain")
        body_type = "text/plain"

    for attachment in args.attach or []:
        path = Path(attachment)
        if not path.is_file():
            fail(f"attachment not found: {path}")
        mime_type, _ = mimetypes.guess_type(path.name)
        if mime_type:
            maintype, subtype = mime_type.split("/", 1)
        else:
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(
            path.read_bytes(),
            maintype=maintype,
            subtype=subtype,
            filename=path.name,
        )

    if not isinstance(smtp_host, str) or not smtp_host:
        fail("config.smtp.host is required")
    if not isinstance(smtp_port, int):
        fail("config.smtp.port must be an integer")

    return msg, all_recipients, body_type


def send_message(msg: EmailMessage, recipients: list[str], config: dict) -> None:
    smtp = config["smtp"]
    host = smtp.get("host", "smtp.exmail.qq.com")
    port = int(smtp.get("port", 465))
    secure = bool(smtp.get("secure", True))
    user = smtp["user"]
    password = smtp["pass"]

    if secure or port == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=context) as server:
            server.login(user, password)
            server.send_message(msg, to_addrs=recipients)
    else:
        context = ssl.create_default_context()
        with smtplib.SMTP(host, port) as server:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
            server.login(user, password)
            server.send_message(msg, to_addrs=recipients)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send WeCom/Exmail email over SMTP")
    parser.add_argument("--to", action="append", required=True, help="recipient(s), comma separated or repeated")
    parser.add_argument("--cc", action="append", help="cc recipient(s)")
    parser.add_argument("--bcc", action="append", help="bcc recipient(s)")
    parser.add_argument("--subject", required=True, help="mail subject")
    parser.add_argument("--body", help="plain text body")
    parser.add_argument("--body-file", help="plain text body file")
    parser.add_argument("--html-file", help="html body file")
    parser.add_argument("--attach", action="append", help="attachment path")
    parser.add_argument("--from-name", help="override sender display name")
    parser.add_argument("--reply-to", help="override reply-to")
    parser.add_argument("--dry-run", action="store_true", help="print summary only")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config, resolved_config_path = load_config(None)
    message, recipients, body_type = build_message(args, config)

    if args.dry_run:
        smtp = config.get("smtp", {})
        print(f"Config: {resolved_config_path}")
        print(
            f"SMTP: {smtp.get('host', 'smtp.exmail.qq.com')}:{int(smtp.get('port', 465))} "
            f"secure={bool(smtp.get('secure', True))}"
        )
        print(f"From: {message['From']}")
        print(f"To: {message['To']}")
        if message.get("Cc"):
            print(f"Cc: {message['Cc']}")
        print(f"Subject: {message['Subject']}")
        print(f"Body-Type: {body_type}")
        print(f"Attachments: {len(args.attach or [])}")
        return

    send_message(message, recipients, config)
    print(f"Mail sent to {', '.join(recipients)}")
    print(f"Subject: {message['Subject']}")


if __name__ == "__main__":
    main()
