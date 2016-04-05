import Promise = require("bluebird");
import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();
import moment = require("moment");

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

var authenticateCheck = common.authenticateMiddleware;

router.route("/schedule").get(authenticateCheck, function (request, response) {
	if (!response.locals.authenticated || !response.locals.user.registered) {
		// Generalized schedule for unknown or unregistered users
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
	}
	else {
		Promise.all([
			db.cypherAsync({
				query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
			}),
			db.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.startTime AS start, s.endTime AS end, s.location AS location, true AS editable",
				"params": {
					username: response.locals.user.username
				}
			})
		]).spread(function (items, sessions) {
			function formatter (item) {
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
			}
			for (let i = 0; i < items.length; i++) {
				// Insert registration choices into schedule at editable periods
				if (items[i].editable) {
					for (let j = 0; j < sessions.length; j++) {
						if (sessions[j].start === items[i].start) {
							items[i] = sessions[j];
							break;
						}
					}
				}
			}
			response.json(items.map(formatter));
		}).catch(common.handleError.bind(response));
	}
});
router.route("/date").get(function (request, response) {
    common.getSymposiumDate().then(function (date: moment.Moment) {
		response.json({
			"formatted": date.format(dateFormat)
		});
	}).catch(common.handleError.bind(response));
});

export = router;