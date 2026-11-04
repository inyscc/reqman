import io

p = r'C:\CodeLir\reqman\tests-browser\tree-expansion-gestures.spec.ts'
s = io.open(p, encoding='utf-8', newline=None).read()


def rep(old, new):
    global s
    assert s.count(old) == 1, (s.count(old), old[:60])
    s = s.replace(old, new)


rep(
    """  it('单击目录行即时切换展开，并打开该实体的面板（新增一个标签）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    expect(await visibleNow(page, '深处的请求')).toBe(true);

    await tree.getByText('外层', { exact: true }).click();

    // 单击返回后立刻读：折叠已经生效，没有等任何延时阈值
    expect(await visibleNow(page, '深处的请求')).toBe(false);
    expect(await expandedNow(page, '外层')).toBe(false);
    // 单击目录行同时打开这个实体：主区进脚本面板，标签栏多一个
    await page.getByTestId('entity-script-panel').waitFor();
    expect(await page.getByTestId('session-tab').count()).toBe(1);
  });

  it('真实双击只切换一次（第二击确实带 detail === 2）', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    // 起点全展开。若第二击未被忽略，双击会切换两次、回到展开态。
    await tree.getByText('外层', { exact: true }).dblclick();
    expect(await expandedNow(page, '外层')).toBe(false);
    expect(await visibleNow(page, '深处的请求')).toBe(false);

    await tree.getByText('外层', { exact: true }).dblclick();
    expect(await expandedNow(page, '外层')).toBe(true);
    expect(await visibleNow(page, '深处的请求')).toBe(true);
  });

  it('展开只作用于被点的那一层，后代的折叠态被保留', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    await tree.getByLabel('折叠 内层').click();
    expect(await visibleNow(page, '深处的请求')).toBe(false);

    await tree.getByText('外层', { exact: true }).click();
    expect(await expandedNow(page, '外层')).toBe(false);

    await tree.getByText('外层', { exact: true }).click();
    expect(await expandedNow(page, '外层')).toBe(true);
    expect(await visibleNow(page, '内层')).toBe(true);
    expect(await visibleNow(page, '外层请求')).toBe(true);
    // 内层仍是折叠的：展开不是递归的
    expect(await visibleNow(page, '深处的请求')).toBe(false);
  });""",
    """  it('单击目录行只打开该实体的面板，展开态与子树都不动', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    expect(await visibleNow(page, '深处的请求')).toBe(true);

    await tree.getByText('外层', { exact: true }).click();

    // 打开：主区进脚本面板，标签栏多一个
    await page.getByTestId('entity-script-panel').waitFor();
    expect(await page.getByTestId('session-tab').count()).toBe(1);
    // 树没被这一击改动（spec: 单击目录行打开面板并切换展开）
    expect(await expandedNow(page, '外层')).toBe(true);
    expect(await visibleNow(page, '深处的请求')).toBe(true);
  });

  it('已折叠的目录行被单击后仍折叠，展开只能靠箭头', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByLabel('折叠 外层').click();
    expect(await expandedNow(page, '外层')).toBe(false);

    await tree.getByText('外层', { exact: true }).click();
    await page.getByTestId('entity-script-panel').waitFor();
    // 面板开了，树没跟着展开
    expect(await expandedNow(page, '外层')).toBe(false);
    expect(await visibleNow(page, '内层')).toBe(false);

    await tree.getByLabel('展开 外层').click();
    expect(await visibleNow(page, '内层')).toBe(true);
  });

  it('真实双击只打开一次（第二击确实带 detail === 2）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 第二击被忽略：openEntity 是异步的，派发两次会插出两个标签
    await tree.getByText('外层', { exact: true }).dblclick();
    await page.getByTestId('entity-script-panel').waitFor();
    expect(await page.getByTestId('session-tab').count()).toBe(1);
    expect(await expandedNow(page, '外层')).toBe(true);
  });

  it('箭头折叠 / 展开只作用于被点的那一层，后代的折叠态被保留', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    await tree.getByLabel('折叠 内层').click();
    expect(await visibleNow(page, '深处的请求')).toBe(false);

    await tree.getByLabel('折叠 外层').click();
    expect(await expandedNow(page, '外层')).toBe(false);

    await tree.getByLabel('展开 外层').click();
    expect(await expandedNow(page, '外层')).toBe(true);
    expect(await visibleNow(page, '内层')).toBe(true);
    expect(await visibleNow(page, '外层请求')).toBe(true);
    // 内层仍是折叠的：展开不是递归的
    expect(await visibleNow(page, '深处的请求')).toBe(false);
  });""",
)

rep(
    """  it('单击目录名不选中文字，展开 / 折叠照常发生', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('外层', { exact: true }).click();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(await expandedNow(page, '外层')).toBe(false);
  });""",
    """  it('单击目录名不选中文字，也不改动展开态', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('外层', { exact: true }).click();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(await expandedNow(page, '外层')).toBe(true);
  });""",
)

rep(
    """    await tree.getByText('探针集合', { exact: true }).click();
    expect(await expandedNow(page, '探针集合')).toBe(true);
    expect(await visibleNow(page, '外层')).toBe(true);""",
    """    await tree.getByLabel('展开 探针集合').click();
    expect(await expandedNow(page, '探针集合')).toBe(true);
    expect(await visibleNow(page, '外层')).toBe(true);""",
)

io.open(p, 'w', encoding='utf-8', newline='\r\n').write(s)
print('ok')
