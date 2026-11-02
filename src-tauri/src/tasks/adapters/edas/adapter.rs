//! EDAS 适配器：把引擎的两个钩子（`prepare` / `publish`）接到控制台读写上。
//!
//! 它是引擎与站点之间唯一的接缝：拿到的是 [`RunContext`]（只能写日志、只能问"要不要停"），
//! 看不到数据库、看不到事件总线。会话失效时**只重登一次**再试本项——
//! 反复重登会把 SSO 页面撞成风控现场。

use std::sync::Arc;

use crate::error::{AppError, Result};
use crate::state::SharedCore;
use crate::tasks::runner::{Prepared, PublishOutcome, RunContext, RunItem, TaskAdapter, LOG_WARN};
use crate::tasks::Env;

use super::client::EdasClient;
use super::profile::EdasProfile;
use super::session::CookieSession;
use super::{allow_http_for, prepare, publish};

pub struct EdasAdapter {
    core: SharedCore,
    actor: String,
    task_key: String,
    env: Env,
    profile: EdasProfile,
}

impl EdasAdapter {
    /// 建适配器就把配置校一遍：让"配置不合法"在点下按钮时就说出来，而不是跑到一半才失败。
    pub fn new(core: SharedCore, actor: &str, task_key: &str, env: Env, profile: EdasProfile) -> Result<Self> {
        profile.validate()?;
        Ok(Self {
            core,
            actor: actor.to_string(),
            task_key: task_key.to_string(),
            env,
            profile,
        })
    }

    pub fn profile(&self) -> &EdasProfile {
        &self.profile
    }

    fn client(&self) -> Result<EdasClient> {
        EdasClient::new(self.profile.clone(), allow_http_for(&self.core))
    }

    fn session(&self) -> Result<Arc<CookieSession>> {
        super::session_for(&self.core, &self.actor, &self.task_key, self.env, &self.profile)
    }

    /// 会话失效只重登一次。第二发还是同样的错就直接失败——这一项的状态由引擎落。
    fn once_then_relogin<T>(
        &self,
        ctx: &RunContext,
        item: &RunItem,
        mut call: impl FnMut(&EdasClient, &CookieSession) -> Result<T>,
    ) -> Result<T> {
        let client = self.client()?;
        let session = self.session()?;
        match call(&client, session.as_ref()) {
            Err(e) if e.code() == "TASK_SESSION_EXPIRED" => {
                ctx.log(LOG_WARN, Some(&item.item_key), "会话已失效：重新静默登录一次后重试本项");
                let fresh = super::refresh_session(&self.core, &self.actor, &self.task_key, self.env, &self.profile)?;
                call(&client, fresh.as_ref())
            }
            other => other,
        }
    }
}

impl TaskAdapter for EdasAdapter {
    fn prepare(&self, ctx: &RunContext, item: &RunItem) -> Result<Prepared> {
        self.once_then_relogin(ctx, item, |client, session| {
            if item.item_key.trim().is_empty() {
                return Err(AppError::InvalidInput);
            }
            prepare::resolve(ctx, client, &self.profile, session, item)
        })
    }

    fn publish(&self, ctx: &RunContext, item: &RunItem) -> Result<PublishOutcome> {
        self.once_then_relogin(ctx, item, |client, session| publish::push(ctx, client, &self.profile, session, item))
    }
}
