# 部署血糖记录

这份说明的目标：把血糖记录放到一个 HTTPS 网址上，然后用爸爸的 iPhone Safari 添加到主屏幕，像 App 一样使用。

## 部署前检查

在项目目录运行：

```bash
./scripts/npm.sh run build
```

如果看到 `built` 或 `✓ built`，说明可以部署。部署用的是 `dist` 文件夹。

## 推荐方式：Vercel

适合长期使用，后续你修改代码后，只要重新推送到 GitHub，Vercel 会自动更新。

### 1. 上传到 GitHub

如果你还没有 GitHub 仓库，可以先用 GitHub Desktop：

1. 打开 GitHub Desktop。
2. 选择 `Add Existing Repository`。
3. 路径选择这个项目：`/path/to/glucose-tracker`。
4. 点击 `Publish repository`。
5. 仓库可以设为 `Private`。

### 2. 在 Vercel 导入项目

1. 打开 Vercel 网站并登录。
2. 选择 `Add New Project`。
3. 选择刚刚发布到 GitHub 的仓库。
4. Framework Preset 选择 `Vite`。
5. Build Command 使用 `npm run build`。
6. Output Directory 使用 `dist`。
7. 点击 Deploy。

项目里已经准备了 `vercel.json`，一般会自动识别这些设置。

### 3. 打开部署网址

部署完成后，Vercel 会给你一个 HTTPS 网址，例如：

```text
https://xxx.vercel.app
```

用 Safari 打开这个网址即可。

## 备用方式：Netlify

如果你不想先连 GitHub，可以先手动上传：

1. 先运行 `./scripts/npm.sh run build`。
2. 打开 Netlify。
3. 新建站点，选择手动部署或拖拽部署。
4. 上传项目里的 `dist` 文件夹。

项目里也准备了 `netlify.toml`，如果通过 GitHub 部署，Netlify 会使用：

```text
Build command: npm run build
Publish directory: dist
```

## 放到爸爸 iPhone 桌面

在爸爸的 iPhone 上：

1. 打开 Safari。
2. 输入部署好的 HTTPS 网址。
3. 点击底部分享按钮。
4. 选择 `添加到主屏幕`。
5. 名称填 `血糖记录`。
6. 以后从桌面图标打开。

注意：请用 Safari，不要用微信内置浏览器添加。

## 正式使用前清空演示数据

演示数据只存在打开过演示链接的那台设备里。正式使用前，在对应设备 Safari 打开：

```text
你的部署网址/?demo=clear
```

例如：

```text
https://xxx.vercel.app/?demo=clear
```

然后回到正常网址：

```text
https://xxx.vercel.app
```

## 更新后没变化怎么办

如果后续更新代码后，iPhone 还显示旧版，打开：

```text
你的部署网址/refresh.html
```

它会自动清理旧缓存，再跳回最新版。

## 数据安全提醒

当前版本的数据保存在本机浏览器里，不会自动同步到云端。

建议定期：

1. 进入设置页。
2. 点击导出 JSON。
3. 把导出的文件保存到 iCloud、微信文件或电脑。

更换手机前，也要先导出 JSON，再在新手机导入。
