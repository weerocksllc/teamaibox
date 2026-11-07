;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;; Copyright (c) Weerocks LLC
;; Team AI Box integration addition; native profile/session operations remain
;; in Penpot. This endpoint is reachable only through the platform boundary.

(ns app.rpc.commands.teamaibox-auth
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.features :as cfeat]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http.client :as client]
   [app.http.session :as session]
   [app.http.websocket :as collaboration]
   [app.loggers.audit :as audit]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.auth :as auth]
   [app.rpc.commands.profile :as profile]
   [app.rpc.commands.teams :as teams]
   [app.rpc.helpers :as rph]
   [app.rpc.permissions :as perms]
   [app.teamaibox.teams :as directory]
   [app.util.json :as json]
   [app.util.services :as sv]
   [app.util.websocket :as ws]
   [clojure.set :as set]
   [yetti.request :as yreq]))

(defn- denied
  []
  (ex/raise :type :authentication :code :teamaibox-handoff-denied))

(defn- require-private-request!
  [params]
  (let [request (rph/get-request params)
        expected (cf/get :teamaibox-handoff-key)
        supplied (yreq/get-header request "authorization")]
    (when-not (and (string? expected) (string? supplied)
                   (java.security.MessageDigest/isEqual
                    (.getBytes (str "Bearer " expected) "UTF-8")
                    (.getBytes supplied "UTF-8"))
                   (nil? (yreq/get-header request "origin"))
                   (nil? (yreq/get-header request "cookie")))
      (denied))))

(defn- exchange
  [cfg params]
  (let [uri        (cf/get :teamaibox-handoff-uri)
        key        (cf/get :teamaibox-handoff-key)
        request    (rph/get-request params)
        identity   (yreq/get-header request "x-teamaibox-identity")
        platform-session (yreq/get-header request "x-teamaibox-session")
        code       (:code params)]
    (when-not (and uri key (string? code)
                   (re-matches #"tabpd1_[A-Za-z0-9_-]{43}" code)
                   (uuid/parse* identity) (uuid/parse* platform-session))
      (denied))
    ;; URI is operator configuration, never a request parameter. No redirect
    ;; following and no browser Cookie/Authorization header is forwarded.
    (let [response (client/req cfg
                              ;; The private platform callback is HTTP/1.1. Do
                              ;; not negotiate h2c through its WS upgrade route.
                              {:method :post :uri uri :timeout 5000 :version :http1.1
                               :headers {"content-type" "application/json"
                                         "authorization" (str "Bearer " key)}
                               :body (json/encode-str {:code code :identityId identity
                                                       :sessionId platform-session})}
                              {:skip-ssrf-check? true})]
      (when-not (= 200 (:status response)) (denied))
      (let [result (json/decode (:body response))
            id     (uuid/parse* (:profileId result))]
        (when-not (and id (= identity (:identityId result))
                       (= platform-session (:sessionId result))
                       (= (str id "@design.invalid") (:contact result))
                       (string? (:fullname result)) (<= (count (:fullname result)) 200))
          (denied))
        (assoc result :id id)))))

(defn- ensure-profile
  [{:keys [::db/conn] :as cfg} {:keys [id contact fullname]}]
  ;; Both first-login requests serialize on the stable platform mapping.
  ;; Never adopt an existing profile by email, display name or a client ID.
  (db/xact-lock! conn id)
  (let [existing (some-> (db/exec-one! conn ["select * from profile where id = ?" id])
                         (profile/decode-row))]
    (if existing
      (do
        (when-not (and (= "teamaibox" (:auth-backend existing))
                       (= contact (:email existing)) (:is-active existing)
                       (not (:is-blocked existing)) (nil? (:deleted-at existing)))
          (denied))
        (-> (db/update! conn :profile {:fullname fullname} {:id id} {::db/return-keys true})
            (profile/decode-row)))
      (->> (auth/create-profile cfg {:id id :email contact :fullname fullname
                                    :backend "teamaibox" :is-active true :is-muted true
                                    :locale "en"})
           (auth/create-profile-rels cfg)))))

(sv/defmethod ::teamaibox-login
  {::rpc/auth false ::audit/skip true}
  [cfg params]
  (let [handoff (exchange cfg params)]
    (db/tx-run! cfg
                (fn [cfg]
                  (let [native (ensure-profile cfg handoff)]
                    (-> (profile/strip-private-attrs native)
                        (rph/with-transform (session/create-fn cfg native))))))))

;; Private read-only permission query for the platform's current MCP target.
;; It uses native membership and file data; it creates no grant and exposes no
;; design content. The platform supplies the mapped profile, never the model.
(sv/defmethod ::teamaibox-file-access
  {::rpc/auth false ::audit/skip true}
  [cfg params]
  (require-private-request! params)
  (let [profile-id (uuid/parse* (:target-profile-id params))
        file-id (uuid/parse* (:file-id params))
        page-id (uuid/parse* (:page-id params))]
    (when-not (and profile-id file-id page-id)
      (denied))
    (directory/synchronize! cfg profile-id)
    (db/tx-run! cfg
      (fn [{:keys [::db/conn] :as cfg}]
        (let [native (db/exec-one! conn ["select * from profile where id = ?" profile-id])
              access (perms/get-file-read-permissions cfg profile-id file-id)]
          (when-not (and (= "teamaibox" (:auth-backend native))
                         (:is-active native) (not (:is-blocked native))
                         (nil? (:deleted-at native)) (:can-read access))
            (denied))
          ;; Disable migrations here: authorization must not mutate a file.
          (let [file (bfc/get-file cfg file-id :migrate? false)]
            (when-not (some #{page-id} (get-in file [:data :pages])) (denied))
            {:profile-id profile-id :file-id file-id :page-id page-id
             :team-id (:team-id file) :can-read true
             :revision (:revn file) :document-version (:vern file) :modified-at (:modified-at file)
             :can-edit (true? (:can-edit access))}))))))

;; Query subscriptions actually accepted by Penpot, not client-reported file
;; IDs. The gateway chooses a fresh connection ID on every upgrade and keeps
;; checking native ACL plus platform team membership for that connection.
(sv/defmethod ::teamaibox-subscription-access
  {::rpc/auth false ::audit/skip true}
  [cfg params]
  (require-private-request! params)
  (let [profile-id (uuid/parse* (:target-profile-id params))
        connection-id (uuid/parse* (:connection-id params))]
    (when-not (and profile-id connection-id) (denied))
    (directory/synchronize! cfg profile-id)
    (let [wsp (some (fn [connection]
                      (when (and (= profile-id (::collaboration/profile-id connection))
                                 (= connection-id (::collaboration/teamaibox-connection-id connection)))
                        connection)) (vals @collaboration/state))
          state (::ws/state wsp)]
      (when-not state (denied))
      (let [targets (fn [] (let [view @state]
                             [(get-in view [::collaboration/team-subscription :team-id])
                              (get-in view [::collaboration/file-subscription :file-id])]))
            [team-id file-id :as before] (targets)
            file-team (when file-id
                        (bfc/check-file-exists cfg file-id)
                        (when-not (:can-read (perms/get-file-read-permissions cfg profile-id file-id)) (denied))
                        (or (perms/get-team-id-for-file cfg file-id) (denied)))]
        (when team-id (teams/check-read-permissions! cfg profile-id team-id))
        (when-not (= before (targets)) (denied))
        {:profile-id profile-id :connection-id connection-id
         :team-ids (vec (distinct (remove nil? [team-id file-team])))}))))

(sv/defmethod ::teamaibox-ensure-team
  {::rpc/auth false ::audit/skip true}
  [cfg params]
  (require-private-request! params)
  (let [profile-id (uuid/parse* (:target-profile-id params))
        team-id (uuid/parse* (:team-id params))
        label (:name params)]
    (when-not (and (directory/enabled?) profile-id team-id (string? label)
                   (<= 1 (count label) 250))
      (denied))
    (db/tx-run! cfg
      (fn [{:keys [::db/conn] :as cfg}]
        (db/xact-lock! conn profile-id)
        (db/xact-lock! conn team-id)
        (when-not (= "admin" (get (directory/roles! profile-id) team-id)) (denied))
        (let [native (db/exec-one! conn ["select id,auth_backend,is_active,is_blocked,deleted_at from profile where id=?" profile-id])
              current (db/exec-one! conn ["select id,teamaibox_founder_id,deleted_at from team where id=?" team-id])]
          (when-not (and (= "teamaibox" (:auth-backend native)) (:is-active native)
                         (not (:is-blocked native)) (nil? (:deleted-at native)))
            (denied))
          (if current
            (when-not (and (:teamaibox-founder-id current) (nil? (:deleted-at current))) (denied))
            (do
              (teams/create-team cfg {:id team-id :profile-id profile-id :name label
                :features (-> (cfeat/get-enabled-features cf/flags)
                              (set/difference cfeat/frontend-only-features)
                              (set/difference cfeat/no-team-inheritable-features))})
              (db/update! conn :team {:teamaibox-founder-id profile-id} {:id team-id})))
          {:team-id team-id})))))
