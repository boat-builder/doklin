//! Every command by name: JSON in, JSON out.
//!
//! The Mac's frontend reaches the commands through Tauri, which names and
//! types each one (src-tauri/src/cloud.rs, versions.rs). An app with no Tauri
//! — the iPhone, through ffi/ — calls them here: the same names, the
//! arguments the Mac's frontend sends (an object, camelCase keys) and the
//! same answers. A command added to cloud/mod.rs or versions/mod.rs gets an
//! arm here; `every_command_has_an_arm` fails until it does.

use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::{cloud, versions, Core};

/// The arguments of one call.
struct Args(Value);

impl Args {
    /// The argument called `key`. One that was left out reads as null, which
    /// is what an optional argument takes for "none".
    fn get<T: DeserializeOwned>(&self, key: &str) -> Result<T, String> {
        let value = self.0.get(key).cloned().unwrap_or(Value::Null);
        serde_json::from_value(value).map_err(|_| format!("`{}` is missing, or is not what this command takes", key))
    }

    /// The argument called `key`, or `default` when it was left out.
    fn or<T: DeserializeOwned>(&self, key: &str, default: T) -> Result<T, String> {
        Ok(self.get::<Option<T>>(key)?.unwrap_or(default))
    }
}

fn json<T: Serialize>(answer: T) -> Result<Value, String> {
    serde_json::to_value(answer).map_err(|e| format!("that answer couldn't be written down: {}", e))
}

/// Run the command called `name`.
pub async fn call(core: &Arc<Core>, name: &str, args: Value) -> Result<Value, String> {
    let a = Args(args);
    match name {
        "cloud_status" => json(cloud::cloud_status(core)?),
        "cloud_mint_token" => json(cloud::cloud_mint_token()),
        "cloud_parse_invite" => json(cloud::cloud_parse_invite(a.get("text")?)),
        "cloud_redeem" => json(cloud::cloud_redeem(core, a.get("endpoint")?, a.get("code")?).await?),
        "cloud_recover" => json(
            cloud::cloud_recover(core, a.get("endpoint")?, a.get("key")?, a.get("email")?, a.get("name")?).await?,
        ),
        "cloud_probe" => json(cloud::cloud_probe(core, a.get("endpoint")?, a.get("token")?).await?),
        "cloud_marker" => json(cloud::cloud_marker(a.get("root")?)),
        "cloud_device_code" => json(cloud::cloud_device_code(core, a.get("root")?).await?),
        "cloud_invite" => {
            json(cloud::cloud_invite(core, a.get("root")?, a.get("email")?, a.get("name")?, a.get("days")?).await?)
        }
        "cloud_people" => json(cloud::cloud_people(core, a.get("root")?).await?),
        "cloud_removed" => json(cloud::cloud_removed(core)?),
        "cloud_set_role" => {
            json(cloud::cloud_set_role(core, a.get("root")?, a.get("memberId")?, a.get("role")?).await?)
        }
        "cloud_revoke_person" => json(cloud::cloud_revoke_person(core, a.get("root")?, a.get("memberId")?).await?),
        "cloud_revoke_device" => json(cloud::cloud_revoke_device(core, a.get("root")?, a.get("tokenId")?).await?),
        "cloud_withdraw_invite" => {
            json(cloud::cloud_withdraw_invite(core, a.get("root")?, a.get("inviteId")?).await?)
        }
        "cloud_agents" => json(cloud::cloud_agents(core, a.get("root")?).await?),
        "cloud_agent_add" => {
            json(cloud::cloud_agent_add(core, a.get("root")?, a.get("name")?, a.get("scopes")?).await?)
        }
        "cloud_agent_code" => json(cloud::cloud_agent_code(core, a.get("root")?, a.get("agentId")?).await?),
        "cloud_agent_update" => json(
            cloud::cloud_agent_update(core, a.get("root")?, a.get("agentId")?, a.get("name")?, a.get("scopes")?)
                .await?,
        ),
        "cloud_agent_remove" => json(cloud::cloud_agent_remove(core, a.get("root")?, a.get("agentId")?).await?),
        "cloud_agent_revoke_machine" => json(
            cloud::cloud_agent_revoke_machine(core, a.get("root")?, a.get("agentId")?, a.get("tokenId")?).await?,
        ),
        "cloud_check_worker" => json(cloud::cloud_check_worker(core, a.get("root")?)?),
        "cloud_connect" => json(
            cloud::cloud_connect(core, a.get("root")?, a.get("endpoint")?, a.get("token")?, a.get("name")?).await?,
        ),
        "cloud_join" => json(cloud::cloud_join(core, a.get("endpoint")?, a.get("token")?).await?),
        "cloud_resume" => {
            json(cloud::cloud_resume(core, a.get("root")?, a.get("endpoint")?, a.get("token")?).await?)
        }
        "cloud_disconnect" => json(cloud::cloud_disconnect(core, a.get("root")?).await?),
        "cloud_leave" => json(cloud::cloud_leave(core, a.get("root")?).await?),
        "cloud_sync_now" => json(cloud::cloud_sync_now(core, a.get("root")?)?),
        "cloud_pause" => json(cloud::cloud_pause(core, a.get("root")?, a.get("paused")?)?),
        "cloud_confirm_deletes" => json(cloud::cloud_confirm_deletes(core, a.get("root")?)?),
        "cloud_confirm_adds" => json(cloud::cloud_confirm_adds(core, a.get("root")?, a.get("sync")?)?),
        "cloud_lift_wait" => json(cloud::cloud_lift_wait(core, a.get("root")?)?),
        "cloud_set_plan" => json(cloud::cloud_set_plan(core, a.get("root")?, a.get("plan")?).await?),
        "cloud_set_focus" => json(cloud::cloud_set_focus(
            core,
            &a.or("window", "main".to_string())?,
            a.get("folder")?,
            a.get("focused")?,
        )?),
        "cloud_set_activity" => {
            json(cloud::cloud_set_activity(core, &a.or("window", "main".to_string())?, a.get("path")?)?)
        }
        "cloud_take_over" => json(cloud::cloud_take_over(core, a.get("root")?, a.get("path")?)?),
        "cloud_publish" => json(
            cloud::cloud_publish(core, a.get("path")?, a.get("slug")?, a.get("title")?, a.get("desc")?).await?,
        ),
        "cloud_unpublish" => json(cloud::cloud_unpublish(core, a.get("root")?, a.get("slug")?).await?),
        "cloud_set_root" => json(cloud::cloud_set_root(core, a.get("root")?, a.get("slug")?).await?),
        "cloud_space_create" => json(
            cloud::cloud_space_create(core, a.get("root")?, a.get("name")?, a.get("members")?, a.get("from")?).await?,
        ),
        "cloud_space_member" => json(
            cloud::cloud_space_member(core, a.get("root")?, a.get("id")?, a.get("memberId")?, a.get("add")?).await?,
        ),
        "cloud_space_delete" => json(cloud::cloud_space_delete(core, a.get("root")?, a.get("id")?).await?),
        "cloud_link" => json(cloud::cloud_link(core, a.get("path")?).await?),
        "cloud_follow_link" => json(cloud::cloud_follow_link(core, a.get("url")?).await?),
        "cloud_link_target" => json(cloud::cloud_link_target(core, a.get("url")?)?),
        "cloud_recent" => json(cloud::cloud_recent(core, a.get("root")?, a.get("limit")?).await?),
        "cloud_pages" => json(cloud::cloud_pages(core, a.get("root")?).await?),
        "cloud_page_take_down" => json(cloud::cloud_page_take_down(core, a.get("root")?, a.get("slug")?).await?),
        "cloud_wipe" => json(cloud::cloud_wipe(core, a.get("root")?).await?),

        "versions_status" => json(versions::versions_status(core)?),
        "versions_snapshots" => json(versions::versions_snapshots(core, a.get("root")?).await?),
        "versions_capture_now" => {
            json(versions::versions_capture_now(core, a.get("root")?, a.get("reason")?, a.get("label")?).await?)
        }
        "versions_set_pinned" => json(
            versions::versions_set_pinned(core, a.get("root")?, a.get("ts")?, a.get("pinned")?, a.get("label")?)
                .await?,
        ),
        "versions_set_enabled" => json(versions::versions_set_enabled(core, a.get("enabled")?)?),
        "versions_history" => json(versions::versions_history(core, a.get("path")?).await?),
        "versions_read" => json(versions::versions_read(core, a.get("root")?, a.get("hash")?).await?),
        "versions_diff" => {
            json(versions::versions_diff(core, a.get("root")?, a.get("path")?, a.get("from")?, a.get("to")?).await?)
        }
        "versions_snapshot_diff" => json(versions::versions_snapshot_diff(core, a.get("root")?, a.get("ts")?).await?),
        "versions_deleted" => json(versions::versions_deleted(core, a.get("root")?).await?),
        "versions_restore_snapshot" => {
            json(versions::versions_restore_snapshot(core, a.get("root")?, a.get("ts")?, a.get("paths")?).await?)
        }
        "versions_set_horizon" => json(versions::versions_set_horizon(core, a.get("root")?, a.get("days")?).await?),
        "versions_set_cloud_horizon" => {
            json(versions::versions_set_cloud_horizon(core, a.get("root")?, a.get("days")?).await?)
        }
        "versions_stores" => json(versions::versions_stores(core).await?),
        "versions_forget" => json(versions::versions_forget(core, a.get("key")?).await?),
        "versions_export" => json(versions::versions_export(core, a.get("root")?, a.get("dest")?).await?),
        "versions_restore_file" => json(
            versions::versions_restore_file(
                core,
                a.get("root")?,
                a.get("path")?,
                a.get("ts")?,
                a.get("hash")?,
                a.get("text")?,
            )
            .await?,
        ),

        // What the Mac does without a command of the engine's: its own write
        // path rings the edit bus, its window registry says which folders
        // are open, and its quit handler flushes.
        "touched" => {
            core.touched(&a.get::<String>("path")?);
            json(())
        }
        "device_name" => json(cloud::device_name(core)),
        "bundled_worker_version" => json(cloud::BUNDLED_WORKER_VERSION),
        "versions_reconcile" => {
            versions::reconcile(core);
            json(())
        }
        "versions_flush" => {
            versions::flush_all(core, Duration::from_millis(a.or("ms", 2000u64)?)).await;
            json(())
        }
        other => Err(format!("there is no command called {}", other)),
    }
}

#[cfg(test)]
mod tests {
    /// The names of the commands a manager declares: every `pub fn` and
    /// `pub async fn` whose name starts with `prefix`.
    fn declared(source: &str, prefix: &str) -> Vec<String> {
        source
            .lines()
            .filter_map(|line| {
                let rest = line.strip_prefix("pub async fn ").or_else(|| line.strip_prefix("pub fn "))?;
                let name = rest.split('(').next()?.trim();
                name.starts_with(prefix).then(|| name.to_string())
            })
            .collect()
    }

    #[test]
    fn every_command_has_an_arm() {
        let here = include_str!("command.rs");
        let cloud = declared(include_str!("cloud/mod.rs"), "cloud_");
        let versions = declared(include_str!("versions/mod.rs"), "versions_");
        assert!(cloud.len() > 30 && versions.len() > 10, "the command lists were not read");
        for name in cloud.iter().chain(versions.iter()) {
            assert!(here.contains(&format!("\"{}\" => ", name)), "command.rs has no arm for {}", name);
        }
    }
}
