;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at https://mozilla.org/MPL/2.0/.
;; Derived from the pinned Penpot workspace media functions. Team AI Box
;; adds an optional original-target fence for native plugin SVG imports.

(defn- check-plugin-svg-target
  [target]
  (when (and target
             (or (not= (select-keys target [:current-file-id :current-page-id])
                       (select-keys @st/state [:current-file-id :current-page-id]))
                 (when-let [active? (:active? target)]
                   (try
                     (not (true? (active?)))
                     (catch :default _ true)))))
    (ex/raise :type :validation
              :code :plugin-target-changed
              :hint "Design target changed during SVG import")))

(defn create-svg-shape
  ([id name svg-string position]
   (create-svg-shape id name svg-string position nil))
  ([id name svg-string position target]
   (ptk/reify ::create-svg-shape
     ptk/WatchEvent
     (watch [_ _ _]
       (->> (svg->clj [name svg-string])
            (rx/take 1)
            (rx/map
             (fn [svg-data]
               (check-plugin-svg-target target)
               (svg/add-svg-shapes id svg-data position {:ignore-selection? true
                                                         :change-selection? false}))))))))

(defn create-svg-shape-with-images
  ([file-id id name svg-string position on-success on-error]
   (create-svg-shape-with-images file-id id name svg-string position on-success on-error nil))
  ([file-id id name svg-string position on-success on-error target]
   (ptk/reify ::create-svg-shape-with-images
     ptk/WatchEvent
     (watch [_ _ _]
       (->> (svg->clj [name svg-string])
            (rx/take 1)
            (rx/mapcat
             (fn [svg-data]
               (check-plugin-svg-target target)
               (->> (svg/upload-images svg-data file-id)
                    (rx/map #(assoc svg-data :image-data %)))))
            (rx/map
             (fn [svg-data]
               (check-plugin-svg-target target)
               (svg/add-svg-shapes
                id
                svg-data
                position
                {:ignore-selection? true
                 :change-selection? false})))
            (rx/tap on-success)
            (rx/catch on-error))))))
