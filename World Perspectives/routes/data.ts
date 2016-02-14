import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();

router.route("/schedule").get(function (request, response) {
    db.cypher({
		query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.time AS time, item.location AS location, item.editable AS editable"
	}, function (err: Error, results) {
		if (err) {
			console.error(err);
			return;
		}
		response.json(results);
	});
});

export = router;