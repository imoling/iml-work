---
name: web-screenshot
description: 网页离屏截图与保存技能，当用户要求对某个网页进行截图、查看网页视图、捕获页面或截图时使用。
trigger_keywords:
  - 截图
  - screenshot
  - 网页截图
  - 截屏
allowed_roles:
  - expert-1
---

# 网页截图技能 SOP

## 核心原则
- 接收用户提供的 URL 地址。如果用户未指定具体 URL，将自动使用默认网址。
- 启动本地静默渲染引擎，载入该网页视图，并捕捉页面快照。
- 将生成的物理图片保存到本地个人文件空间，并返回 HTML/Markdown 图片占位符。

## 使用指导
- 在回复中向用户确认网页截图已成功保存到本地。
- 必须包含占位符 [IMAGE_PLACEHOLDER_PNG] 以便前端加载图像。
