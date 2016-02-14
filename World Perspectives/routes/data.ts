import fs = require("fs");
var keys: {
	"orchestrate": string;
	"neo4j": {
		"username": string;
		"password": string;
		"server": string;
	};
	"pushbullet": string;
	"sendgrid": {
		"username": string;
		"password": string;
	};
	"cookieSecret": string;
} = JSON.parse(fs.readFileSync("keys.json").toString("utf8"));
var neo4j = require("neo4j");
var db = new neo4j.GraphDatabase(`http://${keys.neo4j.username}:${keys.neo4j.password}@${keys.neo4j.server}:7474`);

import express = require("express");
var router = express.Router();

router.route("/schedule").get(function (request, response) {
    db.cypher({
		query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.time AS time, item.location AS location"
	}, function (err: Error, results) {
		if (err) {
			console.error(err);
			return;
		}
		response.json(results);
	});
});

export = router;