# 实现计划

- [x] 1. 添加 CSS 样式
  - 在 `GM_AddCSS()` 函数中添加弹窗样式
  - 包含基础样式、淡入淡出动画、移动端适配
  - _Requirements: 1.1, 1.3, 1.5_

- [x] 2. 实现 ChunkIndicator 核心组件
  - [x] 2.1 创建 ChunkIndicator 对象结构
    - 定义 `_popup`、`_hideTimer`、`settings` 属性
    - _Requirements: 1.1, 2.1_
  
  - [x] 2.2 实现初始化方法 `init()`
    - 等待渲染容器准备就绪
    - 在 `#ao3x-render` 上添加双击事件监听（事件委托）
    - _Requirements: 1.1, 2.1_
  
  - [x] 2.3 实现双击处理方法 `handleDoubleClick()`
    - 阻止默认行为
    - 使用 `closest('.ao3x-block')` 查找分块元素
    - 读取 `data-index` 属性
    - 调用 `showPopup()` 显示弹窗
    - _Requirements: 1.1, 2.1_
  
  - [x] 2.4 实现弹窗显示方法 `showPopup()`
    - 创建或更新弹窗元素
    - 设置弹窗内容（分块编号）
    - 移除隐藏类，触发淡入动画
    - 设置 1 秒后自动隐藏的定时器
    - _Requirements: 1.1, 1.2, 2.1_
  
  - [x] 2.5 实现弹窗隐藏方法 `hidePopup()`
    - 添加隐藏类，触发淡出动画
    - 200ms 后移除 DOM 元素
    - _Requirements: 1.1, 2.1_

- [x] 3. 实现预览文本功能（可选）
  - [x] 3.1 实现 `getPreviewText()` 方法
    - 从 PlanStore 获取分块 HTML
    - 转换为纯文本
    - 提取开头和结尾文本
    - _Requirements: 2.2_
  
  - [x] 3.2 在 `showPopup()` 中集成预览文本
    - 根据 `settings.showPreview` 决定是否显示
    - 添加预览文本的 HTML 结构
    - _Requirements: 2.2, 3.3_

- [x] 4. 集成到脚本主流程
  - 在脚本末尾调用 `ChunkIndicator.init()`
  - 确保在 UI 初始化之后执行
  - _Requirements: 1.1_

- [x] 5. 确保原文模式兼容性
  - 验证原文模式下 `.ao3x-block` 结构保留
  - 验证 `data-index` 属性在原文模式下可用
  - 如需修改，更新 `View.refresh()` 中的原文渲染逻辑
  - _Requirements: 1.5_

- [x] 6. 添加设置面板选项
  - 在设置面板中添加"显示分块预览"开关
  - 保存设置到 `settings` 对象
  - 同步到 `ChunkIndicator.settings.showPreview`
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 7. 测试功能
  - [x] 7.1 测试译文模式
    - 双击译文段落，验证弹窗显示
    - 验证分块编号正确
    - 验证 1 秒后自动消失
    - _Requirements: 1.1, 1.2_
  
  - [x] 7.2 测试原文模式
    - 双击原文段落，验证弹窗显示
    - 验证分块编号正确
    - _Requirements: 1.5_
  
  - [x] 7.3 测试双语对照模式
    - 双击双语段落，验证弹窗显示
    - 验证分块编号正确
    - _Requirements: 1.5_
  
  - [x] 7.4 测试移动端
    - 在 iOS Safari 上测试双击手势
    - 验证弹窗样式和动画
    - _Requirements: 1.3_
  
  - [x] 7.5 测试预览文本功能
    - 开启预览设置
    - 验证预览文本正确显示
    - _Requirements: 2.2, 3.3_
