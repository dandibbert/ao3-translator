# 需求文档

## 简介

本功能旨在为 AO3 翻译脚本添加分块标识功能，使用户能够快速识别每个段落所属的翻译分块，特别是在翻译中断或失败时，能够准确定位问题段落。

## 术语表

- **System**: AO3 翻译脚本系统
- **Chunk**: 翻译分块，指脚本将长文本智能分割后的每个独立翻译单元
- **Chunk Identifier**: 分块标识符，用于标记段落所属分块的视觉元素
- **User**: 使用脚本的移动端 Safari 用户
- **View Mode**: 视图模式，包括译文模式、原文模式、双语对照模式
- **Paragraph**: 段落，指页面中的文本块（p、div、blockquote 等元素）

## 需求

### 需求 1：轻量级分块标识显示

**用户故事：** 作为用户，我希望在查看翻译内容时能够快速识别每个段落属于哪个分块，以便在翻译中断时定位问题。

#### 验收标准

1. WHEN User 查看译文、原文或双语对照页面时，THE System SHALL 在每个段落旁边显示其所属的分块编号
2. THE System SHALL 使用轻量级的视觉设计，确保分块标识不干扰正常阅读体验
3. THE System SHALL 在移动端 Safari 上正确显示分块标识，且不影响页面布局
4. WHERE 段落属于某个分块，THE System SHALL 显示格式为 "#N" 的分块编号（N 为分块索引）
5. THE System SHALL 确保分块标识在所有三种视图模式（译文/原文/双语对照）中都能正确显示

### 需求 2：分块标识的交互功能

**用户故事：** 作为用户，我希望分块标识能够提供额外的交互功能，帮助我更好地管理翻译任务。

#### 验收标准

1. WHEN User 点击分块标识时，THE System SHALL 高亮显示该分块内的所有段落
2. WHEN User 长按分块标识时，THE System SHALL 显示该分块的详细信息（包括分块大小、翻译状态等）
3. THE System SHALL 为未完成或失败的分块使用不同的视觉样式（如颜色标记）
4. THE System SHALL 在移动端 Safari 上支持触摸交互，响应时间不超过 300ms
5. WHERE 分块翻译失败，THE System SHALL 在分块标识上显示警告标记

### 需求 3：分块标识的样式定制

**用户故事：** 作为用户，我希望能够根据个人偏好调整分块标识的显示方式，以获得最佳的阅读体验。

#### 验收标准

1. THE System SHALL 在设置面板中提供分块标识的显示开关
2. THE System SHALL 允许 User 选择分块标识的显示位置（左侧/右侧/顶部）
3. THE System SHALL 允许 User 调整分块标识的透明度（0.3-1.0）
4. THE System SHALL 允许 User 选择分块标识的大小（小/中/大）
5. THE System SHALL 保存 User 的分块标识偏好设置到本地存储

### 需求 4：分块导航功能

**用户故事：** 作为用户，我希望能够快速在不同分块之间导航，特别是在处理长文本时。

#### 验收标准

1. WHEN User 点击工具栏中的"分块导航"按钮时，THE System SHALL 显示所有分块的概览列表
2. THE System SHALL 在分块概览中显示每个分块的状态（完成/进行中/失败/未开始）
3. WHEN User 在分块概览中选择某个分块时，THE System SHALL 滚动页面到该分块的第一个段落
4. THE System SHALL 在分块概览中高亮显示当前可见的分块
5. THE System SHALL 在移动端 Safari 上提供流畅的滚动动画（不超过 500ms）

### 需求 5：分块信息持久化

**用户故事：** 作为用户，我希望分块信息能够与翻译缓存一起保存，以便在刷新页面后仍能看到分块标识。

#### 验收标准

1. WHEN System 保存翻译缓存时，THE System SHALL 同时保存每个段落的分块归属信息
2. WHEN User 刷新页面并加载缓存时，THE System SHALL 恢复分块标识的显示
3. THE System SHALL 确保分块信息的存储不超过 10KB 额外空间
4. WHEN User 清除翻译缓存时，THE System SHALL 同时清除分块归属信息
5. THE System SHALL 在缓存数据结构中使用高效的格式存储分块信息
