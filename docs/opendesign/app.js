(() => {
  const roleMeta = {
    orchestrator: { name: "流程编排", status: "进行中", copy: "当前阶段" },
    preflight: { name: "前置检查", status: "等待", copy: "等待输入" },
    btc: { name: "BTC 分析", status: "等待", copy: "并行分支" },
    eth: { name: "ETH 分析", status: "等待", copy: "并行分支" },
    synthesizer: { name: "汇总研判", status: "等待", copy: "合流" },
    reviewer: { name: "最终复核", status: "等待", copy: "收口" }
  };

  const viewTitles = {
    login: ["工作台 / 登录", "登录"],
    workflow: ["工作台 / 工作流", "对话"],
    positions: ["工作台 / 持仓", "持仓详情"],
    settings: ["工作台 / 设置", "设置"]
  };

  const appState = {
    view: "workflow",
    theme: localStorage.getItem("tyche-theme") || "dark",
    role: "orchestrator",
    asset: "BTC_USDT",
    scene: "workflow"
  };

  const root = document.documentElement;
  const body = document.body;
  const app = document.querySelector("#tyche-app");
  const messageList = document.querySelector("[data-message-list]");
  const composer = document.querySelector("[data-composer]");
  const composerInput = document.querySelector("#composer-input");
  const composerStatus = document.querySelector("[data-composer-status]");

  function setView(view) {
    appState.view = view;
    render();
  }

  function setRole(role) {
    appState.role = role;
    appState.view = "workflow";
    render();
  }

  function render() {
    root.dataset.theme = appState.theme;
    body.dataset.view = appState.view;
    app.dataset.view = appState.view;

    document.querySelector("[data-theme-toggle]").textContent = appState.theme === "dark" ? "浅色" : "深色";
    document.querySelector("[data-breadcrumb]").textContent = viewTitles[appState.view][0];
    document.querySelector("[data-title]").textContent = viewTitles[appState.view][1];

    document.querySelectorAll("[data-screen]").forEach((screen) => {
      screen.classList.toggle("is-active", screen.dataset.screen === appState.view);
    });

    document.querySelectorAll("[data-view-button]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.viewButton === appState.view));
    });

    document.querySelectorAll("[data-role-button]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.roleButton === appState.role));
    });

    document.querySelectorAll("[data-scene-button]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.sceneButton === appState.scene));
    });

    document.querySelectorAll("[data-asset-button]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.assetButton === appState.asset));
    });

    const role = roleMeta[appState.role];
    document.querySelector("[data-current-stage]").textContent = role.name;
    document.querySelector("[data-role-name]").textContent = role.name;
    document.querySelector("[data-role-status]").textContent = role.status;
    document.querySelector("[data-asset-title]").textContent = appState.asset === "BTC_USDT" ? "BTC" : "ETH";
    document.querySelector("[data-run-status]").textContent = appState.view === "settings" ? "待保存" : "待配置";
  }

  document.querySelectorAll("[data-view-button]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewButton));
  });

  document.querySelectorAll("[data-view-shortcut]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewShortcut));
  });

  document.querySelectorAll("[data-role-button]").forEach((button) => {
    button.addEventListener("click", () => setRole(button.dataset.roleButton));
  });

  document.querySelectorAll("[data-scene-button]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.scene = button.dataset.sceneButton;
      if (appState.scene === "trading") appState.view = "positions";
      render();
    });
  });

  document.querySelectorAll("[data-asset-button]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.asset = button.dataset.assetButton;
      render();
    });
  });

  document.querySelector("[data-theme-toggle]").addEventListener("click", () => {
    appState.theme = appState.theme === "dark" ? "light" : "dark";
    localStorage.setItem("tyche-theme", appState.theme);
    render();
  });

  document.querySelector("[data-run-button]").addEventListener("click", () => {
    setView("settings");
    composerStatus.textContent = "运行前需要完成连接与模拟设置";
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = composerInput.value.trim();
    if (!value) {
      composerStatus.textContent = "消息为空";
      return;
    }

    const userMessage = document.createElement("article");
    userMessage.className = "message message-user";
    userMessage.innerHTML = `<span class="message-author">你</span><div class="message-bubble"><p></p></div>`;
    userMessage.querySelector("p").textContent = value;
    messageList.append(userMessage);

    const reply = document.createElement("article");
    reply.className = "message";
    reply.innerHTML = `<span class="message-author">Tyche</span><div class="message-bubble"><p>已记录。当前预览不连接后台，真实运行仍以工程中的控制平面为准。</p></div>`;
    messageList.append(reply);

    composerInput.value = "";
    composerStatus.textContent = "已加入当前对话";
    messageList.scrollTop = messageList.scrollHeight;
  });

  document.querySelector("[data-login-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    document.querySelector("[data-login-status]").textContent = "已在预览中进入";
    setView("workflow");
  });

  document.querySelector("[data-resume]").addEventListener("click", () => {
    document.querySelector("[data-login-status]").textContent = "可恢复状态 —";
  });

  document.querySelector("[data-settings-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    document.querySelector("[data-run-status]").textContent = "检测中";
    window.setTimeout(() => {
      document.querySelector("[data-run-status]").textContent = "待配置";
    }, 900);
  });

  render();
})();
