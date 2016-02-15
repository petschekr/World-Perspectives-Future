import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();

router.route("/schedule").get(function (request, response) {
    db.cypherAsync({
		query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.time AS time, item.location AS location, item.editable AS editable"
	}).then(function (results) {
		response.json(results);
	}).catch(function (err: Error) {
		common.handleError(err);
	});
});

export = router;