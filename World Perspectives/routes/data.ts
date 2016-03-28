import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();
import moment = require("moment");

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

router.route("/schedule").get(function (request, response) {
    db.cypherAsync({
		query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
	}).then(function (results) {
		response.json(results.map(function (item) {
			var startTime = item.start;
			delete item.start;
			var endTime = item.end;
			delete item.end;
			item.time = {
				"start": {
					"raw": startTime,
					"formatted": moment(startTime).format(timeFormat)
				},
				"end": {
					"raw": endTime,
					"formatted": moment(endTime).format(timeFormat)
				}
			};
			return item;
		}));
	}).catch(common.handleError.bind(response));
});
router.route("/date").get(function (request, response) {
    common.getSymposiumDate().then(function (date: moment.Moment) {
		response.json({
			"formatted": date.format(dateFormat)
		});
	}).catch(common.handleError.bind(response));
});

export = router;