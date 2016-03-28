import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();

router.route("/schedule").get(function (request, response) {
    db.cypherAsync({
		query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.time AS time, item.location AS location, item.editable AS editable"
	}).then(function (results) {
		response.json(results);
	}).catch(common.handleError.bind(response));
});
router.route("/date").get(function (request, response) {
    common.getSymposiumDate().then(function (date: moment.Moment) {
		response.json({
			"formatted": date.format("MMMM Do, YYYY")
		});
	}).catch(common.handleError.bind(response));
});

export = router;