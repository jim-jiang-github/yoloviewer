# YOLO 标注查看器

一个轻量的桌面小工具，用来查看 YOLO 格式的标注数据集。打开数据集文件夹后，即可逐张浏览图片和叠加的标注框，并按类别筛选、搜索文件名。

![应用截图](docs/screenshot.png)

## 功能

- 自动识别图片与同名的 `.txt` 标注文件，支持 `data.yaml` / `classes.txt` 中的类别名
- 标注框、类别标签、按类别筛选显示，右侧可查看标注框坐标
- 图片列表搜索、前后切换、滚轮缩放、拖拽平移、适应窗口
- 统计数据集图片数、标注框数与类别分布

## 使用

从 [Releases](https://github.com/jim-jiang-github/yoloviewer/releases) 下载 Windows 版 exe，运行后点「打开文件夹」选择数据集目录即可。

快捷键：`←` / `→` 切换图片，滚轮缩放，拖拽平移，`0` 适应窗口，`L` 显示/隐藏标签。

## 开发

基于 Tauri 2 + Vite。

```bash
npm install
npm run tauri dev
npm run tauri build
```

推送 `v*` 形式的 tag 会自动触发 GitHub Actions 构建并发布 Release。
