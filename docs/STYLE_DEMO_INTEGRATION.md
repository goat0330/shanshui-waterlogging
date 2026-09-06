# 上海三维 Demo

入口：`/?view=3d-demo`。`/` 保留接入前的 MVP：现有 Astra、OSM v2、相机、曝光和业务面板均走原分支。

Demo 独立启用 landuse、Building Surface v3、道路配色、场景光照和全屏视图。顶部可切换城市全景、外围材质近景、Astra aerial_45，并返回正式 MVP。

## 数据与图层

- `frontend/public/data/scene/shanghai-landuse.geojson`：真实 Overpass 查询所得 8,526 个 OSM 闭合 way，范围 121.40–121.60 E、31.17–31.31 N。住宅 3,749、商业 726、工业 348、公共设施 940、绿地 2,763。ODbL。relation-only 地块没有伪造补齐。
- `frontend/scripts/fetch_shanghai_landuse.py` 可重新获取数据。服务超时会重试、拆分查询，并复用临时目录中的成功响应。
- 道路复用已有 `shanghai-major-roads.geojson`。Demo 仅构建上述范围内的道路，避免为全上海画面外道路分配渲染资源。当前数据实际只有 primary、trunk、motorway；四级规则不会生成缺失支路。地下道路隐藏，桥梁不伪造高程。
- 地块仅分类地形、zIndex 1；道路仅分类地形、zIndex 9–12。Flood、Sensor、Forecast 沿用原逻辑。

## 材质与场景

OSM v3 清空 tileset style，使用稳定 feature ID 分配示意材质，以地理向上方向区分屋顶和墙面。浮点 ID 插值后先取整再散列，避免同一立面出现材质跳变噪点。窗格有导数抗混叠；底部深色带以椭球高度近似，只是表面视觉，不改变建筑几何。

仅 Demo 隐藏 Astra 中覆盖过大范围的 `DK__柏油马路` 节点，让真实地块和独立道路可见。GLB 文件、建筑变换和原 PBR 均未改写。当前运行使用的 Astra 文件是此前本地资产，本次源码提交不包含该已有二进制改动。

HDR、IBL 与软投影保留；曝光保持 1.05。实际浏览器发现屏幕空间 AO 在当前深度范围产生噪点，因而关闭 SSAO，保留资产材质 AO。Golden 保存在 `reference/style-demo/`，色板与显示补偿见场景模块。

## 验证

在 frontend 执行 `npm run typecheck`、`node scripts/style_demo_smoke.mjs`、`npm run build`。浏览器截图位于 `frontend/review/style-demo/`。

2026-09-06 已在同一 main 的生产预览 `http://127.0.0.1:4173/` 实测：Demo 的 Astra source-pbr、OSM 可见瓦片、8,526 地块、道路与水系加载成功；全景、近景及 Astra 视角完成截图。`/` 为 mvp、landuse disabled、existing surface；实际切换 PLUS_10 后 Sensor 仍为 28.6 cm，再恢复 NOW。MVP 前后截图的场景和布局一致，非实时视频帧可能不同。当前后端不可用，业务使用页面明示的 fixture fallback，此次不代表后端实时链路验收。

截图：`demo-wide.jpg`、`demo-closeup.jpg`、`astra-aerial-45.jpg`、`mvp-before.jpg`、`mvp-after.jpg`，均为 1920×1080。开发入口仍为 `http://127.0.0.1:5173/?view=3d-demo`；生产预览用于避免多页热更新反复重建 Cesium 的内存开销。

视觉边界：OSM 是简化体块，程序窗格不代表真实建筑材料。当前数据不含 Golden 中的树木、车辆、精细屋顶和水面倒影；材质与街区层次的改善不能等同于完整复现参考图。
